import { Action, ActionPanel, Form, Icon, getPreferenceValues, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useEffect, useRef, useState } from "react";

import { isBiometricUnlockInProgress, setBiometricUnlockInProgress } from "./adapters/external-session";
import { adapterNeedsAuth } from "./registry";
import type { AdapterStatus, AuthRequirements, PasswordManagerAdapter } from "./types";
import {
  clearStoredCredentials,
  confirmPresence,
  hasStoredCredentials,
  isTouchIdAvailable,
  storeCredentialsForTouchId,
  unlockWithTouchId,
} from "./utils/biometric-auth";
import {
  clearRememberedCredentials,
  getExtensionSessionState,
  hasRememberedCredentials,
  isExtensionSessionEnabled,
  isKeychainPersistEnabled,
  peekCredentials,
  rememberCredentials,
  unlockExtensionSessionAfterPresence,
} from "./utils/credential-vault";

const FALLBACK_REQUIREMENTS: AuthRequirements = {
  fields: [{ id: "password", label: "Passwort", type: "password" }],
};

type SessionPreferences = {
  enableExtensionSession?: boolean;
  persistCredentialsInKeychain?: boolean;
};

export function UnlockForm({
  adapter,
  adapterStatuses,
  activeManagerId,
  preferredManagerId,
  onManagerChange,
  onUnlocked,
  onActivity,
}: {
  adapter: PasswordManagerAdapter;
  adapterStatuses: Array<{ adapter: PasswordManagerAdapter; status: AdapterStatus }>;
  activeManagerId: string;
  preferredManagerId?: string;
  onManagerChange: (managerId: string) => void;
  onUnlocked: () => void;
  onActivity: () => void;
}) {
  const preferences = getPreferenceValues<SessionPreferences>();
  const sessionEnabled = preferences.enableExtensionSession !== false;
  const persistInKeychain = preferences.persistCredentialsInKeychain === true;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const autoPromptedRef = useRef(false);

  const { data: requirements, isLoading: isLoadingRequirements } = usePromise(
    async (adapterId: string) => {
      const selected = adapterStatuses.find((entry) => entry.adapter.id === adapterId)?.adapter;
      if (!selected?.getAuthRequirements) {
        return FALLBACK_REQUIREMENTS;
      }

      try {
        return await selected.getAuthRequirements();
      } catch {
        return FALLBACK_REQUIREMENTS;
      }
    },
    [adapter.id],
  );

  const sessionState = getExtensionSessionState();
  const ramStored = hasRememberedCredentials(adapter.id);
  const presenceUnlock = sessionEnabled && sessionState === "locked" && ramStored;

  const {
    data: touchIdState,
    isLoading: isLoadingTouchId,
    revalidate: revalidateTouchId,
  } = usePromise(
    async (adapterId: string, persist: boolean, usePresence: boolean, epoch: number) => {
      void epoch;
      const available = await isTouchIdAvailable();
      if (usePresence) {
        return { available, stored: ramStored, eligible: available, mode: "presence" as const };
      }

      if (!persist) {
        return { available, stored: false, eligible: false, mode: "keychain" as const };
      }

      const stored = available ? await hasStoredCredentials(adapterId) : false;
      return {
        available,
        stored,
        eligible: available && stored,
        mode: "keychain" as const,
      };
    },
    [adapter.id, persistInKeychain, presenceUnlock, sessionEpoch],
  );

  const fields = requirements?.fields ?? FALLBACK_REQUIREMENTS.fields;
  const availableAdapters = adapterStatuses.filter((entry) => entry.status.ok).map((entry) => entry.adapter);
  const lockedAdapters = adapterStatuses.filter((entry) => adapterNeedsAuth(entry.status));
  const unavailableAdapters = adapterStatuses.filter((entry) => !entry.status.ok && !adapterNeedsAuth(entry.status));
  const touchIdEligible = touchIdState?.eligible === true;
  const unlockWithBiometricsRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    autoPromptedRef.current = false;
  }, [adapter.id, presenceUnlock]);

  useEffect(() => {
    if (!touchIdEligible || isSubmitting || autoPromptedRef.current || isBiometricUnlockInProgress()) {
      return;
    }

    autoPromptedRef.current = true;
    void unlockWithBiometricsRef.current();
  }, [touchIdEligible, adapter.id, isSubmitting]);

  useEffect(() => {
    if (isLoadingRequirements || isLoadingTouchId || !requirements || requirements.fields.length > 0) {
      return;
    }

    if (touchIdEligible || isSubmitting || autoPromptedRef.current || isBiometricUnlockInProgress()) {
      return;
    }

    autoPromptedRef.current = true;
    void (async () => {
      setIsSubmitting(true);
      try {
        await authenticateWithCredentials({});
      } finally {
        setIsSubmitting(false);
      }
    })();
  }, [requirements, isLoadingRequirements, isLoadingTouchId, touchIdEligible, isSubmitting]);

  async function persistCredentialsAfterUnlock(credentials: Record<string, string>): Promise<void> {
    if (isExtensionSessionEnabled()) {
      rememberCredentials(adapter.id, credentials);
    }

    if (!isKeychainPersistEnabled()) {
      try {
        await clearStoredCredentials(adapter.id);
      } catch {
        // Clearing is best-effort; a failed delete must not look like a failed unlock.
      }
      return;
    }

    try {
      await storeCredentialsForTouchId(adapter.id, credentials);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Touch ID save failed",
        message: error instanceof Error ? error.message : "Session is unlocked. Retry Keychain setup later.",
      });
    }
  }

  async function authenticateWithCredentials(credentials: Record<string, string>): Promise<boolean> {
    if (!adapter.authenticate) {
      return false;
    }

    const status = await adapter.authenticate(credentials);
    if (status.ok) {
      await persistCredentialsAfterUnlock(credentials);
      onUnlocked();
      return true;
    }

    await showToast({
      style: Toast.Style.Failure,
      title: "Unlock failed",
      message: status.reason,
    });
    return false;
  }

  async function unlockWithBiometrics(): Promise<void> {
    if (!adapter.authenticate || isSubmitting) {
      return;
    }

    onActivity();
    setIsSubmitting(true);
    setBiometricUnlockInProgress(true);

    try {
      if (presenceUnlock) {
        const confirmed = await confirmPresence();
        if (!confirmed) {
          return;
        }

        unlockExtensionSessionAfterPresence();
        setSessionEpoch((value) => value + 1);

        const credentials = peekCredentials(adapter.id);
        if (!credentials) {
          return;
        }

        const status = await adapter.isAvailable();
        if (status.ok) {
          onUnlocked();
          return;
        }

        clearRememberedCredentials(adapter.id);
        await showToast({
          style: Toast.Style.Failure,
          title: "Unlock failed",
          message: status.reason,
        });
        return;
      }

      const credentials = await unlockWithTouchId(adapter.id);
      if (!credentials) {
        return;
      }

      const unlocked = await authenticateWithCredentials(credentials);
      if (!unlocked) {
        await clearStoredCredentials(adapter.id);
        await revalidateTouchId();
      }
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Unlock failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBiometricUnlockInProgress(false);
      setIsSubmitting(false);
    }
  }

  unlockWithBiometricsRef.current = unlockWithBiometrics;

  async function handleSubmit(values: Record<string, string>): Promise<void> {
    if (!adapter.authenticate) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Unlock failed",
        message: "Adapter does not support authentication",
      });
      return;
    }

    onActivity();
    setIsSubmitting(true);

    const credentials: Record<string, string> = {};
    for (const field of fields) {
      credentials[field.id] = values[field.id] ?? "";
    }

    try {
      await authenticateWithCredentials(credentials);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Unlock failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleForgetTouchId(): Promise<void> {
    try {
      await clearStoredCredentials(adapter.id);
      await revalidateTouchId();
      await showToast({ style: Toast.Style.Success, title: "Touch ID credentials removed" });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to remove Touch ID credentials",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <Form
      navigationTitle={adapter.name}
      isLoading={isLoadingRequirements || isLoadingTouchId || isSubmitting}
      actions={
        <ActionPanel>
          {touchIdEligible ? (
            <Action title="Unlock with Touch ID" icon={Icon.Fingerprint} onAction={unlockWithBiometrics} />
          ) : null}
          <Action.SubmitForm
            title={touchIdEligible ? "Enter Password/PIN" : "Unlock"}
            icon={Icon.LockUnlocked}
            onSubmit={handleSubmit}
          />
          {persistInKeychain && touchIdState?.stored && touchIdState.mode === "keychain" ? (
            <Action title="Forget Touch ID Credentials" icon={Icon.Trash} onAction={handleForgetTouchId} />
          ) : null}
        </ActionPanel>
      }
    >
      {preferredManagerId ? (
        <Form.Dropdown id="manager" title="Password Manager" value={activeManagerId} onChange={onManagerChange}>
          {availableAdapters.length > 0 && (
            <Form.Dropdown.Section title="Available">
              {availableAdapters.map((entry) => (
                <Form.Dropdown.Item key={entry.id} title={entry.name} value={entry.id} />
              ))}
            </Form.Dropdown.Section>
          )}
          {lockedAdapters.length > 0 && (
            <Form.Dropdown.Section title="Locked">
              {lockedAdapters.map((entry) => (
                <Form.Dropdown.Item key={entry.adapter.id} title={entry.adapter.name} value={entry.adapter.id} />
              ))}
            </Form.Dropdown.Section>
          )}
          {unavailableAdapters.length > 0 && (
            <Form.Dropdown.Section title="Unavailable">
              {unavailableAdapters.map((entry) => (
                <Form.Dropdown.Item key={entry.adapter.id} title={entry.adapter.name} value={entry.adapter.id} />
              ))}
            </Form.Dropdown.Section>
          )}
        </Form.Dropdown>
      ) : null}
      {touchIdEligible ? (
        <Form.Description text="Unlock with Touch ID from the action panel, or enter your password/PIN. The biometric prompt may dismiss Raycast; reopen Search Passwords after success." />
      ) : fields.length === 0 ? (
        <Form.Description text="No password manager unlock is required. The extension session will start automatically." />
      ) : sessionEnabled && sessionState === "empty" ? (
        <Form.Description text="Enter your master password/PIN to start the extension session. After the session expires, unlock with Touch ID." />
      ) : null}
      {fields.map((field) =>
        field.type === "text" ? (
          <Form.TextField key={field.id} id={field.id} title={field.label} />
        ) : (
          <Form.PasswordField key={field.id} id={field.id} title={field.label} />
        ),
      )}
    </Form>
  );
}
