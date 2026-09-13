import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Icon,
  Keyboard,
  List,
  closeMainWindow,
  getPreferenceValues,
  open,
  showToast,
  Toast,
  type Image,
} from "@raycast/api";
import { useCachedPromise, usePromise } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  cancelScheduledDispose,
  disposeSession,
  isBiometricUnlockInProgress,
  scheduleDisposeAllSessions,
} from "./adapters/external-session";
import { getExternalAdaptersDirectoryForDisplay } from "./registry/load-external-adapters";
import {
  adapterNeedsAuth,
  getAvailableAdapters,
  isAdapterSelectable,
  loadAdapters,
  resolveManagerId,
} from "./registry";
import type { ItemAvailability, PasswordManagerAdapter, VaultItem } from "./types";
import { UnlockForm } from "./unlock-form";
import {
  getExtensionSessionState,
  hydrateCredentialVault,
  isExtensionSessionEnabled,
  lockExtensionSession,
  lockExtensionSessionIfExpired,
  markSessionActivity,
  parseSessionTimeoutMinutes,
  rememberCredentials,
  subscribeToExtensionSession,
} from "./utils/credential-vault";
import { filterVaultItems } from "./utils/items";
import { loadLastManagerId, saveLastManagerId } from "./utils/last-manager-selection";

const TOTP_DELAY_MS = 5000;
const SESSION_DISPOSE_REMOUNT_GRACE_MS = 250;

let pendingTotpCopies = 0;

function beginPendingTotpCopy(): void {
  pendingTotpCopies += 1;
}

function endPendingTotpCopy(): void {
  pendingTotpCopies = Math.max(0, pendingTotpCopies - 1);
}

function pendingSessionDisposeDelayMs(): number {
  return pendingTotpCopies > 0 ? TOTP_DELAY_MS + 500 : 0;
}

const SHORTCUTS: Record<string, Keyboard.Shortcut> = {
  pastePassword: {
    macOS: { modifiers: ["cmd", "shift"], key: "return" },
    Windows: { modifiers: ["ctrl", "shift"], key: "enter" },
  },
  copyEmail: {
    macOS: { modifiers: ["cmd"], key: "c" },
    Windows: { modifiers: ["ctrl"], key: "c" },
  },
  copyPassword: {
    macOS: { modifiers: ["cmd", "shift"], key: "c" },
    Windows: { modifiers: ["ctrl", "shift"], key: "c" },
  },
  copyTotp: {
    macOS: { modifiers: ["cmd"], key: "t" },
    Windows: { modifiers: ["ctrl"], key: "t" },
  },
};

interface CredentialActionOptions {
  scheduleTotp?: boolean;
  autoCopyTotpAfterPassword?: boolean;
  hasTotp?: boolean;
  adapter?: PasswordManagerAdapter;
  item?: VaultItem;
}

function defaultAvailability(item: VaultItem): ItemAvailability {
  return {
    hasUrl: Boolean(item.url),
    url: item.url,
    hasEmail: Boolean(item.email),
    hasUsername: Boolean(item.username),
    hasTotp: item.hasTotp === true,
    hasPassword: true,
  };
}

async function resolveItemAvailability(adapter: PasswordManagerAdapter, item: VaultItem): Promise<ItemAvailability> {
  if (adapter.getItemAvailability) {
    return adapter.getItemAvailability(item);
  }

  const [url, email, username, totpResult] = await Promise.all([
    adapter.getUrl?.(item),
    adapter.getEmail(item).catch(() => undefined),
    adapter.getUsername(item).catch(() => undefined),
    adapter.getTotp(item).catch(() => undefined),
  ]);

  let hasPassword = true;
  try {
    const password = await adapter.getPassword(item);
    hasPassword = Boolean(password);
  } catch {
    hasPassword = false;
  }

  return {
    hasUrl: Boolean(url),
    url,
    hasEmail: Boolean(email),
    hasUsername: Boolean(username),
    hasTotp: Boolean(totpResult),
    hasPassword,
  };
}

function ItemAction({
  title,
  icon,
  shortcut,
  onAction,
  onActivity,
}: {
  title: string;
  icon: Image.ImageLike;
  shortcut?: Keyboard.Shortcut;
  onAction: () => Promise<void>;
  onActivity?: () => void;
}) {
  return (
    <Action
      title={title}
      icon={icon}
      shortcut={shortcut}
      onAction={async () => {
        onActivity?.();
        await onAction();
      }}
    />
  );
}

async function showActionError(title: string, message?: string): Promise<void> {
  await showToast({ style: Toast.Style.Failure, title, message });
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldScheduleTotpCopy(options?: CredentialActionOptions): boolean {
  if (!options?.scheduleTotp || !options.autoCopyTotpAfterPassword || !options.adapter || !options.item) {
    return false;
  }

  return options.hasTotp === true;
}

async function scheduleTotpCopy(adapter: PasswordManagerAdapter, item: VaultItem): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TOTP_DELAY_MS));

  try {
    const totp = await adapter.getTotp(item);
    if (!totp) {
      return;
    }

    await Clipboard.copy(totp);
    await showToast({ style: Toast.Style.Success, title: "TOTP copied" });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to copy TOTP",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function closeThenToast(
  toast: { style: Toast.Style; title: string; message?: string },
  shouldClose: boolean,
): Promise<void> {
  if (shouldClose) {
    await closeMainWindow();
  }

  await showToast(toast);
}

function startScheduledTotpCopy(options?: CredentialActionOptions): boolean {
  if (!shouldScheduleTotpCopy(options) || !options?.adapter || !options.item) {
    return false;
  }

  beginPendingTotpCopy();
  return true;
}

function finishScheduledTotpCopy(adapter: PasswordManagerAdapter, item: VaultItem): void {
  void scheduleTotpCopy(adapter, item).finally(endPendingTotpCopy);
}

async function copyCredential(
  label: string,
  value: string,
  closeAfterCopy: boolean,
  options?: CredentialActionOptions,
): Promise<void> {
  await Clipboard.copy(value);

  const scheduleTotp = startScheduledTotpCopy(options);

  await closeThenToast(
    {
      style: Toast.Style.Success,
      title: `${label} copied`,
      message: scheduleTotp ? "TOTP in 5 seconds" : undefined,
    },
    closeAfterCopy,
  );

  if (scheduleTotp && options?.adapter && options.item) {
    finishScheduledTotpCopy(options.adapter, options.item);
  } else if (scheduleTotp) {
    endPendingTotpCopy();
  }
}

async function pasteCredential(label: string, value: string, options?: CredentialActionOptions): Promise<void> {
  await Clipboard.paste(value);

  const scheduleTotp = startScheduledTotpCopy(options);

  await closeThenToast(
    {
      style: Toast.Style.Success,
      title: `${label} pasted`,
      message: scheduleTotp ? "TOTP in 5 seconds" : undefined,
    },
    true,
  );

  if (scheduleTotp && options?.adapter && options.item) {
    finishScheduledTotpCopy(options.adapter, options.item);
  } else if (scheduleTotp) {
    endPendingTotpCopy();
  }
}

function ItemActions({
  item,
  adapter,
  closeAfterCopy,
  autoCopyTotpAfterPassword,
  onActivity,
  onLock,
}: {
  item: VaultItem;
  adapter: PasswordManagerAdapter;
  closeAfterCopy: boolean;
  autoCopyTotpAfterPassword: boolean;
  onActivity: () => void;
  onLock: () => void;
}) {
  const { data: availabilityData } = useCachedPromise(
    (vaultItem: VaultItem, pwdAdapter: PasswordManagerAdapter) => resolveItemAvailability(pwdAdapter, vaultItem),
    [item, adapter],
    {
      initialData: defaultAvailability(item),
    },
  );

  const availability = availabilityData ?? defaultAvailability(item);

  const passwordTotpOptions: CredentialActionOptions = {
    scheduleTotp: true,
    autoCopyTotpAfterPassword,
    hasTotp: availability.hasTotp,
    adapter,
    item,
  };

  return (
    <ActionPanel>
      <ItemAction
        title="Open in Browser"
        icon={Icon.Globe}
        onActivity={onActivity}
        onAction={async () => {
          if (!adapter.getUrl) {
            await showActionError("Not supported");
            return;
          }

          if (!availability.hasUrl) {
            await showActionError("No URL available");
            return;
          }

          try {
            const url = availability.url ?? (await adapter.getUrl(item));
            if (!url) {
              await showActionError("No URL available");
              return;
            }

            await open(url);
            await closeMainWindow();
          } catch (error) {
            await showActionError("Failed to open in browser", actionErrorMessage(error));
          }
        }}
      />
      <ItemAction
        title="Paste Email"
        icon={Icon.Envelope}
        onActivity={onActivity}
        onAction={async () => {
          if (!availability.hasEmail) {
            await showActionError("No email available");
            return;
          }

          try {
            const email = await adapter.getEmail(item);
            if (!email) {
              await showActionError("No email available");
              return;
            }

            await pasteCredential("Email", email);
          } catch (error) {
            await showActionError("Failed to paste email", actionErrorMessage(error));
          }
        }}
      />
      <ItemAction
        title="Paste Password"
        icon={Icon.Key}
        shortcut={SHORTCUTS.pastePassword}
        onActivity={onActivity}
        onAction={async () => {
          if (!availability.hasPassword) {
            await showActionError("No password available");
            return;
          }

          try {
            const password = await adapter.getPassword(item);
            if (!password) {
              await showActionError("No password available");
              return;
            }

            await pasteCredential("Password", password, passwordTotpOptions);
          } catch (error) {
            await showActionError("Failed to paste password", actionErrorMessage(error));
          }
        }}
      />
      <ItemAction
        title="Copy Email"
        icon={Icon.Envelope}
        shortcut={SHORTCUTS.copyEmail}
        onActivity={onActivity}
        onAction={async () => {
          if (!availability.hasEmail) {
            await showActionError("No email available");
            return;
          }

          try {
            const email = await adapter.getEmail(item);
            if (!email) {
              await showActionError("No email available");
              return;
            }

            await copyCredential("Email", email, closeAfterCopy);
          } catch (error) {
            await showActionError("Failed to copy email", actionErrorMessage(error));
          }
        }}
      />
      <ItemAction
        title="Copy Password"
        icon={Icon.Key}
        shortcut={SHORTCUTS.copyPassword}
        onActivity={onActivity}
        onAction={async () => {
          if (!availability.hasPassword) {
            await showActionError("No password available");
            return;
          }

          try {
            const password = await adapter.getPassword(item);
            if (!password) {
              await showActionError("No password available");
              return;
            }

            await copyCredential("Password", password, closeAfterCopy, passwordTotpOptions);
          } catch (error) {
            await showActionError("Failed to copy password", actionErrorMessage(error));
          }
        }}
      />
      <ItemAction
        title="Copy TOTP"
        icon={Icon.Clock}
        shortcut={SHORTCUTS.copyTotp}
        onActivity={onActivity}
        onAction={async () => {
          if (!availability.hasTotp) {
            await showActionError("No TOTP available");
            return;
          }

          try {
            const totp = await adapter.getTotp(item);
            if (!totp) {
              await showActionError("No TOTP available");
              return;
            }

            await copyCredential("TOTP", totp, closeAfterCopy);
          } catch (error) {
            await showActionError("Failed to copy TOTP", actionErrorMessage(error));
          }
        }}
      />
      <ItemAction
        title="Copy Username"
        icon={Icon.Person}
        onActivity={onActivity}
        onAction={async () => {
          if (!availability.hasUsername) {
            await showActionError("No username available");
            return;
          }

          try {
            const username = await adapter.getUsername(item);
            if (!username) {
              await showActionError("No username available");
              return;
            }

            await copyCredential("Username", username, closeAfterCopy);
          } catch (error) {
            await showActionError("Failed to copy username", actionErrorMessage(error));
          }
        }}
      />
      {adapter.openInManager && (
        <ItemAction
          title="Open in Password Manager"
          icon={Icon.AppWindow}
          onActivity={onActivity}
          onAction={async () => {
            try {
              await adapter.openInManager!(item);
              await closeMainWindow();
            } catch (error) {
              await showActionError("Failed to open in password manager", actionErrorMessage(error));
            }
          }}
        />
      )}
      <ItemAction title="Lock Session" icon={Icon.Lock} onActivity={onActivity} onAction={async () => onLock()} />
    </ActionPanel>
  );
}

export default function SearchPasswords() {
  const preferences = getPreferenceValues<Preferences & { sessionTimeoutMinutes?: string }>();
  const closeAfterCopy = preferences.closeAfterCopy ?? true;
  const autoCopyTotpAfterPassword = preferences.autoCopyTotpAfterPassword ?? false;

  const {
    data: adapterStatuses,
    isLoading: isLoadingAdapters,
    revalidate: revalidateAdapterStatuses,
  } = usePromise(getAvailableAdapters);

  const { isLoading: isLoadingVault } = usePromise(hydrateCredentialVault);
  const { data: lastManagerId, isLoading: isLoadingLastManager } = usePromise(loadLastManagerId);

  const allAdapters = useMemo(() => adapterStatuses?.map((entry) => entry.adapter) ?? [], [adapterStatuses]);

  const [sessionManagerId, setSessionManagerId] = useState<string | undefined>(undefined);
  const [unlockedIds, setUnlockedIds] = useState<string[]>([]);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [searchText, setSearchText] = useState("");
  const dropdownChangeCountRef = useRef(0);
  const initialSelectionAppliedRef = useRef(false);
  const activeManagerIdRef = useRef<string | undefined>(undefined);
  const lastActivityRef = useRef(Date.now());
  const previousManagerIdRef = useRef<string | undefined>(undefined);

  const availableAdapters = useMemo(
    () =>
      adapterStatuses
        ?.filter((entry) => entry.status.ok || unlockedIds.includes(entry.adapter.id))
        .map((entry) => entry.adapter) ?? [],
    [adapterStatuses, unlockedIds],
  );

  const lockedAdapters = useMemo(
    () =>
      adapterStatuses?.filter((entry) => adapterNeedsAuth(entry.status) && !unlockedIds.includes(entry.adapter.id)) ??
      [],
    [adapterStatuses, unlockedIds],
  );

  const unavailableAdapters = useMemo(
    () => adapterStatuses?.filter((entry) => !entry.status.ok && !adapterNeedsAuth(entry.status)) ?? [],
    [adapterStatuses],
  );

  const selectableAdapters = useMemo(
    () => adapterStatuses?.filter((entry) => isAdapterSelectable(entry.status)).map((entry) => entry.adapter) ?? [],
    [adapterStatuses],
  );

  const preferredManagerId = useMemo(() => {
    const override = preferences.defaultManagerOverride?.trim();
    const preferred = override || preferences.defaultManagerId;
    return resolveManagerId(preferred, selectableAdapters, allAdapters);
  }, [allAdapters, selectableAdapters, preferences.defaultManagerId, preferences.defaultManagerOverride]);

  const resolvedInitialManagerId = useMemo(() => {
    if (lastManagerId && allAdapters.some((adapter) => adapter.id === lastManagerId)) {
      return lastManagerId;
    }
    return preferredManagerId;
  }, [allAdapters, lastManagerId, preferredManagerId]);

  function markActivity(): void {
    if (getExtensionSessionState() === "locked") {
      return;
    }

    lastActivityRef.current = Date.now();
    markSessionActivity();
  }

  function bumpSessionEpoch(): void {
    setSessionEpoch((value) => value + 1);
  }

  useEffect(() => {
    dropdownChangeCountRef.current = 0;
    setSessionManagerId(undefined);
    initialSelectionAppliedRef.current = false;
  }, [preferences.defaultManagerId, preferences.defaultManagerOverride]);

  useEffect(() => {
    if (initialSelectionAppliedRef.current || isLoadingAdapters || isLoadingLastManager) {
      return;
    }

    const initial =
      lastManagerId && allAdapters.some((adapter) => adapter.id === lastManagerId) ? lastManagerId : preferredManagerId;

    if (initial) {
      setSessionManagerId(initial);
    }

    dropdownChangeCountRef.current = 0;
    initialSelectionAppliedRef.current = true;
  }, [allAdapters, isLoadingAdapters, isLoadingLastManager, lastManagerId, preferredManagerId]);

  const activeManagerId = sessionManagerId ?? resolvedInitialManagerId;

  activeManagerIdRef.current = activeManagerId;

  useEffect(() => {
    return () => {
      const managerId = activeManagerIdRef.current;
      if (managerId) {
        void saveLastManagerId(managerId);
      }
    };
  }, []);

  useEffect(() => {
    return subscribeToExtensionSession(() => {
      setSessionEpoch((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    cancelScheduledDispose();
    return () => {
      if (isBiometricUnlockInProgress()) {
        return;
      }

      scheduleDisposeAllSessions(SESSION_DISPOSE_REMOUNT_GRACE_MS + pendingSessionDisposeDelayMs());
    };
  }, []);

  useEffect(() => {
    const previous = previousManagerIdRef.current;
    if (previous && previous !== activeManagerId) {
      void disposeSession(previous);
      if (!isExtensionSessionEnabled()) {
        setUnlockedIds((ids) => ids.filter((id) => id !== previous));
      }
    }

    previousManagerIdRef.current = activeManagerId;
  }, [activeManagerId]);

  useEffect(() => {
    if (!activeManagerId) {
      return;
    }

    const timeoutMs = parseSessionTimeoutMinutes(preferences.sessionTimeoutMinutes) * 60_000;
    const tick = (): void => {
      if (isExtensionSessionEnabled()) {
        if (lockExtensionSessionIfExpired()) {
          void disposeSession(activeManagerId);
          bumpSessionEpoch();
        }
        return;
      }

      if (Date.now() - lastActivityRef.current < timeoutMs) {
        return;
      }

      lastActivityRef.current = Date.now();
      void disposeSession(activeManagerId);
      setUnlockedIds((ids) => ids.filter((id) => id !== activeManagerId));
    };

    tick();
    const handle = setInterval(tick, 1000);

    return () => clearInterval(handle);
  }, [activeManagerId, preferences.sessionTimeoutMinutes]);

  const selectedAdapter =
    selectableAdapters.find((adapter) => adapter.id === activeManagerId) ??
    allAdapters.find((adapter) => adapter.id === activeManagerId);
  const selectedStatus = adapterStatuses?.find((entry) => entry.adapter.id === activeManagerId)?.status;
  const extensionSessionState = getExtensionSessionState();
  const canAutoBootstrapExtensionSession = Boolean(
    selectedAdapter &&
    selectedStatus?.ok &&
    !adapterNeedsAuth(selectedStatus) &&
    isExtensionSessionEnabled() &&
    selectedAdapter.authenticate &&
    extensionSessionState === "empty" &&
    !unlockedIds.includes(selectedAdapter.id),
  );
  const needsExtensionUnlock =
    sessionEpoch >= 0 &&
    isExtensionSessionEnabled() &&
    Boolean(selectedAdapter?.authenticate) &&
    (extensionSessionState === "empty" || extensionSessionState === "locked") &&
    !canAutoBootstrapExtensionSession;
  const showUnlockForm = Boolean(
    selectedAdapter &&
    (needsExtensionUnlock ||
      (selectedStatus && adapterNeedsAuth(selectedStatus) && !unlockedIds.includes(selectedAdapter.id))),
  );
  const isSessionReady = Boolean(
    selectedAdapter && selectedStatus && (selectedStatus.ok || unlockedIds.includes(selectedAdapter.id)),
  );
  const supportsLocalCache = Boolean(selectedAdapter?.listItems);
  const canLoadItems = isSessionReady && !showUnlockForm;

  useEffect(() => {
    if (!canAutoBootstrapExtensionSession || !selectedAdapter) {
      return;
    }

    rememberCredentials(selectedAdapter.id, {});
    setUnlockedIds((ids) => (ids.includes(selectedAdapter.id) ? ids : [...ids, selectedAdapter.id]));
    bumpSessionEpoch();
  }, [canAutoBootstrapExtensionSession, selectedAdapter?.id]);

  const {
    data: allItems,
    isLoading: isLoadingLocalItems,
    error: localItemsError,
    revalidate: revalidateLocalItems,
  } = useCachedPromise(
    async (managerId: string) => {
      const adapters = await loadAdapters();
      const adapter = adapters.find((entry) => entry.id === managerId);
      if (!adapter?.listItems) {
        return [];
      }

      return adapter.listItems();
    },
    [activeManagerId ?? ""],
    {
      execute: Boolean(activeManagerId) && supportsLocalCache && canLoadItems,
      keepPreviousData: true,
    },
  );

  const {
    data: remoteItems,
    isLoading: isLoadingRemoteItems,
    error: remoteItemsError,
    revalidate: revalidateRemoteItems,
  } = useCachedPromise(
    async (managerId: string, query: string) => {
      const adapters = await loadAdapters();
      const adapter = adapters.find((entry) => entry.id === managerId);
      if (!adapter) {
        return [];
      }

      return adapter.searchItems(query);
    },
    [activeManagerId ?? "", searchText],
    {
      execute: Boolean(activeManagerId) && !supportsLocalCache && canLoadItems,
      keepPreviousData: false,
    },
  );

  const items = useMemo(() => {
    if (supportsLocalCache) {
      return allItems ? filterVaultItems(allItems, searchText) : undefined;
    }

    return remoteItems;
  }, [allItems, remoteItems, searchText, supportsLocalCache]);

  const isLoadingItems = supportsLocalCache ? isLoadingLocalItems : isLoadingRemoteItems;
  const searchError = supportsLocalCache ? localItemsError : remoteItemsError;
  const revalidateItems = supportsLocalCache ? revalidateLocalItems : revalidateRemoteItems;

  async function reloadItems(): Promise<void> {
    markActivity();
    try {
      await revalidateItems();
      await showToast({ style: Toast.Style.Success, title: "Items reloaded" });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to reload items",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function applyManagerSelection(managerId: string): void {
    markActivity();
    setSessionManagerId(managerId);
    void saveLastManagerId(managerId);
  }

  async function lockActiveSession(): Promise<void> {
    if (!activeManagerId) {
      return;
    }

    markActivity();
    if (isExtensionSessionEnabled()) {
      lockExtensionSession();
      bumpSessionEpoch();
    } else {
      setUnlockedIds((ids) => ids.filter((id) => id !== activeManagerId));
    }
    await disposeSession(activeManagerId);
    void revalidateAdapterStatuses();
  }

  function handleListManagerChange(managerId: string): void {
    dropdownChangeCountRef.current += 1;

    if (dropdownChangeCountRef.current === 1) {
      return;
    }

    applyManagerSelection(managerId);
  }

  if (isLoadingVault || isLoadingLastManager || isLoadingAdapters) {
    return <List isLoading navigationTitle="Password Managers" />;
  }

  if (!isLoadingAdapters && selectableAdapters.length === 0) {
    const externalDirectory = getExternalAdaptersDirectoryForDisplay();
    const setupMarkdown = [
      "# No password manager available",
      "",
      "Register built-in adapters in `src/adapters/index.ts`, install their CLIs, or add external adapters.",
      "",
      "## Registered adapters",
      "",
      ...(allAdapters.length > 0
        ? allAdapters.map((adapter) => {
            const status = adapterStatuses?.find((entry) => entry.adapter.id === adapter.id)?.status;
            const reason = status && !status.ok ? status.reason : "Unknown";
            const kind = adapter.kind === "external" ? "external" : "built-in";
            return `- **${adapter.name}** (${adapter.id}, ${kind}): ${reason}`;
          })
        : ["- No adapters registered"]),
      "",
      "## External adapters",
      "",
      externalDirectory
        ? `Scanning \`${externalDirectory}\` for subfolders with \`pwm-adapter.json\`.`
        : "Set extension preference **External Adapters Directory** (e.g. `~/.config/raycast-pwm/adapters`).",
      "",
      "See `examples/external-adapter/protonpass` or `examples/external-adapter/threepass` for reference implementations.",
      "",
      "## CLI path overrides",
      "",
      'Set extension preference `CLI Path Overrides (JSON)` e.g. `{"1password": "/opt/homebrew/bin/op"}` on macOS or `{"protonpass": "%LOCALAPPDATA%\\\\Programs\\\\pass-cli\\\\pass-cli.exe"}` on Windows',
    ].join("\n");

    return <Detail markdown={setupMarkdown} />;
  }

  const unavailableSelection = unavailableAdapters.find(({ adapter }) => adapter.id === activeManagerId);

  if (showUnlockForm && selectedAdapter && activeManagerId) {
    return (
      <UnlockForm
        adapter={selectedAdapter}
        adapterStatuses={adapterStatuses ?? []}
        activeManagerId={activeManagerId}
        preferredManagerId={preferredManagerId}
        onManagerChange={applyManagerSelection}
        onUnlocked={() => {
          markActivity();
          setUnlockedIds((ids) => (ids.includes(selectedAdapter.id) ? ids : [...ids, selectedAdapter.id]));
          bumpSessionEpoch();
          void revalidateAdapterStatuses();
        }}
        onActivity={markActivity}
      />
    );
  }

  return (
    <List
      navigationTitle={selectedAdapter?.name ?? "Password Managers"}
      searchText={searchText}
      onSearchTextChange={(text) => {
        markActivity();
        setSearchText(text);
      }}
      searchBarPlaceholder="Search passwords..."
      throttle
      isLoading={isLoadingAdapters || isLoadingVault || isLoadingLastManager || (canLoadItems && isLoadingItems)}
      actions={
        selectedAdapter ? (
          <ActionPanel>
            <Action title="Reload Items" icon={Icon.ArrowClockwise} onAction={reloadItems} />
            <Action title="Lock Session" icon={Icon.Lock} onAction={lockActiveSession} />
          </ActionPanel>
        ) : undefined
      }
      searchBarAccessory={
        preferredManagerId ? (
          <List.Dropdown
            key={`manager-${preferences.defaultManagerId}-${preferredManagerId}`}
            id="pwm-manager"
            tooltip="Password Manager"
            storeValue={false}
            value={activeManagerId}
            onChange={handleListManagerChange}
          >
            <List.Dropdown.Section title="Available">
              {availableAdapters.map((adapter) => (
                <List.Dropdown.Item key={adapter.id} title={adapter.name} value={adapter.id} />
              ))}
            </List.Dropdown.Section>
            {lockedAdapters.length > 0 && (
              <List.Dropdown.Section title="Locked">
                {lockedAdapters.map(({ adapter }) => (
                  <List.Dropdown.Item key={adapter.id} title={adapter.name} value={adapter.id} icon={Icon.Lock} />
                ))}
              </List.Dropdown.Section>
            )}
            {unavailableAdapters.length > 0 && (
              <List.Dropdown.Section title="Unavailable">
                {unavailableAdapters.map(({ adapter }) => (
                  <List.Dropdown.Item
                    key={adapter.id}
                    title={adapter.name}
                    value={adapter.id}
                    icon={Icon.ExclamationMark}
                  />
                ))}
              </List.Dropdown.Section>
            )}
          </List.Dropdown>
        ) : undefined
      }
    >
      {searchError && (
        <List.EmptyView icon={Icon.ExclamationMark} title="Search failed" description={searchError.message} />
      )}
      {!searchError && !selectedAdapter && unavailableSelection && (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Password manager unavailable"
          description={unavailableSelection.status.ok ? undefined : unavailableSelection.status.reason}
        />
      )}
      {!searchError && selectedAdapter && items?.length === 0 && (
        <List.EmptyView icon={Icon.MagnifyingGlass} title="No items found" description="Try a different search term" />
      )}
      {items?.map((item) => (
        <List.Item
          key={item.id}
          title={item.title}
          subtitle={item.subtitle}
          keywords={[item.username, item.email].filter((value): value is string => Boolean(value))}
          accessories={[
            ...(item.email ? [{ text: item.email, icon: Icon.Envelope }] : []),
            ...(item.username ? [{ text: item.username, icon: Icon.Person }] : []),
          ]}
          icon={Icon.Key}
          actions={
            selectedAdapter ? (
              <ItemActions
                item={item}
                adapter={selectedAdapter}
                closeAfterCopy={closeAfterCopy}
                autoCopyTotpAfterPassword={autoCopyTotpAfterPassword}
                onActivity={markActivity}
                onLock={() => {
                  void lockActiveSession();
                }}
              />
            ) : undefined
          }
        />
      ))}
    </List>
  );
}
