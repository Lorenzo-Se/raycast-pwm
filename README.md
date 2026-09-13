# Password Managers (Raycast Extension)

Raycast-Extension mit generalisiertem CLI-Adapter-System für Password Manager. Built-in-Adapter liegen unter `src/adapters/`, Third-Party-Adapter können per Stdio-Protokoll extern hinzugefügt werden.

## Features

- Suchen und Auflisten von Vault-Einträgen
- Passwort, Username und TOTP kopieren
- Direkt einfügen in die aktive App (Paste)
- Multi-Manager-Umschalter in der Suche
- PIN-Entsperrung für Proton Pass (6-stellige Session-PIN)
- Externe Third-Party-Adapter über konfigurierbaren Ordner
- Touch ID / Apple Watch / Gerätecode für die Extension-Session nach Timeout (macOS, lokal/dev)

## Entwicklung

```bash
npm install
npm run dev
```

Öffne Raycast → **Developer** → den laufenden Dev-Mode-Extension nutzen → **Search Passwords**.

Touch ID kompiliert ein kleines Swift-CLI (`swift/BiometricAuth/main.swift`) mit **swiftc** aus den Command Line Tools — die volle Xcode-App ist nicht nötig. `npm run dev` / `npm run build` rufen `npm run build-biometric` und `npm run build-session-helper` zuerst auf.

Die Extension-Session läuft über einen detached **Session-Helper** (`assets/session-helper.mjs`): Credentials bleiben nur im Helper-RAM und überleben Extension-Remounts, solange Raycast läuft. Es werden keine Klartext-Dateien in `/tmp` geschrieben. Der Helper beendet sich automatisch, wenn Raycast beendet wird.

Der Raycast Store lehnt Keychain-Zugriff ab — Touch-ID-Re-Auth ist für lokale/Dev-Builds gedacht, nicht für Store-Submission.

### Extension-Einstellungen

| Einstellung                          | Beschreibung                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Default Manager                      | Built-in-Adapter im Dropdown (oder Auto)                                                                                       |
| Default Manager Override             | Adapter-ID für externe Adapter als Default                                                                                     |
| External Adapters Directory          | Ordner mit Third-Party-Adaptern, z. B. `~/.config/raycast-pwm/adapters`                                                        |
| CLI Path Overrides (JSON)            | macOS: `{"1password": "/opt/homebrew/bin/op"}` · Windows: `{"protonpass": "%LOCALAPPDATA%\\Programs\\pass-cli\\pass-cli.exe"}` |
| Close window after copying           | Raycast nach Copy schließen                                                                                                    |
| Auto-copy TOTP after password action | TOTP nach 5 Sekunden automatisch kopieren                                                                                      |
| Session timeout (minutes)            | Idle-Lock nach 1–1440 Minuten (Default 15). Mit Extension-Session: Touch ID. Ohne: Password Manager erneut entsperren          |
| Enable extension session             | Eigene Raycast-Session: Master-PW/PIN im Session-Helper-RAM, stilles Re-Unlock der Manager bis Timeout oder Raycast-Quit (Default an) |
| Remember in Keychain                 | macOS: Credentials in der Keychain, damit Touch ID auch nach einem Raycast-Neustart geht (Default aus)                         |

## Built-in Password Manager hinzufügen

Siehe [src/adapters/README.md](src/adapters/README.md).

Kurzversion:

1. `src/adapters/<manager>.ts` mit `PasswordManagerAdapter` anlegen
2. In `src/adapters/index.ts` registrieren
3. Optional CLI-Pfad in Extension-Einstellungen setzen

## Externe Adapter hinzufügen

1. Referenz kopieren:

```bash
mkdir -p ~/.config/raycast-pwm/adapters
cp -R examples/external-adapter/protonpass ~/.config/raycast-pwm/adapters/protonpass
```

2. In Raycast **External Adapters Directory** setzen: `~/.config/raycast-pwm/adapters`

3. Pro Adapter einen Unterordner mit `pwm-adapter.json` + Script

Protokoll und Auth: [src/adapters/README.md](src/adapters/README.md)

Referenz-Adapter: [examples/external-adapter/protonpass](examples/external-adapter/protonpass/README.md), [examples/external-adapter/threepass](examples/external-adapter/threepass/README.md)

## Projektstruktur

```
src/
├── search-passwords.tsx   # Haupt-Command (UI)
├── unlock-form.tsx        # Master-PW/PIN + Touch ID
├── types.ts               # Adapter-Interface
├── registry.ts            # Adapter-Registry
├── registry/
│   └── load-external-adapters.ts
├── adapters/
│   ├── index.ts           # Built-in Adapter-Liste
│   ├── external-protocol.ts
│   ├── external-script-adapter.ts
│   ├── protonpass.ts
│   └── README.md
└── utils/
    ├── adapter-auto-unlock.ts
    ├── biometric-auth.ts
    ├── cli.ts
    ├── credential-vault.ts
    ├── items.ts
    ├── paths.ts
    ├── raycast-process.ts
    └── session-helper-client.ts

assets/session-helper.mjs              # Session-Helper (RAM-only, IPC)
swift/BiometricAuth/                   # Touch ID + Keychain CLI (macOS, swiftc)
examples/external-adapter/protonpass/  # Proton Pass CLI (extern)
examples/external-adapter/threepass/   # ThreePass (extern, persistent + Master-PW)
```

## Lizenz

MIT
