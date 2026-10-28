# MC Companion

Native Expo (React Native) companion app for **Mission Control** — NZ1Labs'
3D war-room dashboard for the overnight fleet. View machine/LLM health, create
and dispatch kanban tasks, approve/deny agent requests, and tail operator logs,
all from a phone on the LAN.

Built with **Expo SDK 57 / React Native 0.86 / React 19**. No backend code lives
here — this app talks to the Mission Control REST API served by `server.py`.

---

## Table of contents

- [Screens](#screens)
- [Architecture](#architecture)
- [Network & TLS: why it's hard, and how it works](#network--tls-why-its-hard-and-how-it-works)
- [Project layout](#project-layout)
- [Run it](#run-it)
- [Build a release APK (EAS)](#build-a-release-apk-eas)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Releases & history notes](#releases--history-notes)

---

## Screens

| Tab | File (all in `App.js`) | What it does |
|---|---|---|
| **Dash** | `Dash` | Polls `/api/state` and renders machines/Titans, daemons/LLMs, tasks, drones/cron, economy. Pull-to-refresh. |
| **Tasks** | `Tasks` | Create a card (`POST /api/task/create`) then trigger the dispatcher (`POST /api/dispatch`) in one flow. Also lists the current board. |
| **Approvals** | `Approvals` | Lists pending approval requests from `/api/approvals`; approve/deny via `POST /api/approvals/resolve`. |
| **Logs** | `Logs` | Tails the operator activity log from `/api/logs/operator`. |
| **Set** | `Settings` | Change the MC base URL at runtime (persisted in-memory for the session). |

Polling is every **4 s** (`POLL_MS`). All requests go through one `api(path, opts)`
helper that normalises JSON responses and records connection state for the
top-bar status dot.

## Architecture

```
┌─────────────────────┐  HTTPS :8777   ┌───────────────────────────┐  :11434   ┌────────────┐
│  MC Companion (RN)  │ ─────────────▶ │  Windows port-forward     │ ────────▶ │  WSL MC    │
│  (Android / iOS)    │  self-signed   │  -> WSL TLS proxy         │  HTTP     │  server.py │
└─────────────────────┘    CA-pinned   └───────────────────────────┘           └────────────┘
        │
        └─ Expo Router-free: single App.js, hand-rolled tab state.
```

Data flow is **read-heavy and stateless**: each screen is a thin component over a
`usePoller(api, path)` hook that fetches on mount and re-fetches every 4 s. No
Redux/Zustand/React Query — the app is deliberately dependency-light.

### API contract (from `mission-control/server.py`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/state` | machines / daemons / tasks / drones / economy |
| GET | `/api/profiles` | profile list |
| GET | `/api/approvals` | pending approvals + gates |
| GET | `/api/logs/operator` | operator activity log lines |
| POST | `/api/task/create` | `{ title, assignee?, body? }` |
| POST | `/api/dispatch` | `{ max }` — run the kanban worker |
| POST | `/api/approvals/resolve` | `{ id, decision: 'approve'\|'deny', by }` |

## Network & TLS: why it's hard, and how it works

The hard rule that shapes everything: **Android's device policy blocks cleartext
HTTP**, and the phone is on the same LAN as Mission Control.

Naively pointing the app at `http://<lan-host-ip>:8777` fails. So MC is fronted by
HTTPS with a **self-signed CA**, and the app has to trust it:

1. **`DEFAULT_BASE`** in `App.js` points at `https://<lan-host-ip>:8777`.
2. `plugins/withNetworkSecurityConfig.js` is an Expo prebuild plugin that, on
   `expo prebuild` (or EAS build), runs the following on the generated native
   project:
   - Writes `res/xml/resource_name.xml` — a `<network-security-config>` that
     trusts the bundled `mc_ca` cert for host `<lan-host-ip>`.
   - Copies `assets/mc_ca.crt` into `res/raw/` so the CA ships **inside** the APK.
   - String-injects `android:networkSecurityConfig="@xml/resource_name"` into the
     generated `AndroidManifest.xml`'s `<application>` tag (the manifest AST
     parser chokes on the un-prefixed attribute, so it's done via regex on the
     raw text — see the file header for the full backstory).
3. iOS allows arbitrary loads via `NSAppTransportSecurity`.

> **Security note:** the CA is a self-signed CA that only exists on the NZ1Labs
> LAN. It is not a public CA and must never be treated as one. In a production
> rollout, replace this with a proper CA or mTLS.

## Project layout

```
mc-companion/
├── App.js                        # Everything UI (5 tabs, poller hook, API helper)
├── app.json                      # Expo config (bundle IDs, android/ios settings)
├── eas.json                      # EAS build profiles (development / preview / production)
├── index.js                      # registerRootComponent(App)
├── assets/
│   └── mc_ca.crt                 # Bundled self-signed CA (trusted by the app)
├── plugins/
│   └── withNetworkSecurityConfig.js  # Expo prebuild plugin: NSC XML + CA + manifest injection
└── .gitignore
```

## Run it

```bash
npm install
npx expo start
```

Then scan the QR with Expo Go, or press `a` for the Android emulator.

### Pointing at a different MC server

Either edit `DEFAULT_BASE` in `App.js` (permanent) or use the **Set** tab at
runtime (session-only). The Settings tab shows the common gotchas:

- **Physical phone:** forward `<lan-host-ip>:8777` → WSL, then use that IP.
- **Android emulator:** `adb reverse tcp:8777 tcp:8777`, then use
  `http://10.0.2.2:8777`.

## Build a release APK (EAS)

```bash
npm install -g eas-cli
eas login
eas build -p android --profile production
```

Uses the `production` profile in `eas.json` (`autoIncrement: true` bumps the
version code on every build).

## Configuration reference

| Setting | Location | Purpose |
|---|---|---|
| `DEFAULT_BASE` | `App.js` | Fallback / reset base URL when not overridden in Settings. |
| `POLL_MS` | `App.js` | Dashboard poll interval (ms). |
| `version` / `buildNumber` | `app.json` → `expo` | App version strings. |
| `ios.bundleIdentifier` / `android.package` | `app.json` | Bundle IDs (both `com.nz1labs.mccompanion`). |
| `mc_ca.crt` | `assets/` | Self-signed CA used to trust the LAN HTTPS proxy. |
| `mc_base_url` | AsyncStorage | Persisted base URL (Settings tab saves here, app loads on boot). |

## Troubleshooting

**`http` requests fail with "Cleartext HTTP traffic not permitted"**
Correct — that's the Android policy. Use `https://` to the TLS proxy, or add the
domain to `<base-config cleartextTrafficPermitted="true">` in the plugin's
network security config and rebuild.

**`SSL handshake failed` / `trust anchor not found` on a fresh device**
The app only trusts the bundled CA for exactly `<lan-host-ip>`. If MC moves to a
different machine/IP, update `DEFAULT_BASE` **and** the `<domain>` in the plugin,
and rebuild (the CA + domain are compiled in at build time).

**After `npx expo prebuild`, the app no longer trusts the CA**
The manifest injection is idempotent (checks `!includes('NetworkSecurityConfig')`).
If your change reorders `prebuild`/`run:android` such that the generated manifest
already has the attribute (or the AST normalises it differently), you'll see the
trust chain break. Delete the generated `android/` dir and re-run the prebuild.

**Port 8777 unreachable from phone**
Confirm the Windows port-forward → WSL → TLS proxy chain end-to-end from the
phone's browser first (e.g. `https://<lan-host-ip>:8777/api/state`). If that loads,
the app will connect.

## Verify the connection (QA harness)

Instead of only eyeballing `https://<base>/api/state` in a browser (the
troubleshooting step above), run the bundled contract verifier — it checks the
TLS trust chain **with the same bundled CA the app uses** and validates every
documented GET endpoint's response shape:

```bash
npm run verify                 # read-only checks vs DEFAULT_BASE (TLS-verified)
npm run verify -- --write     # also exercise POST /api/task/create (self-cleans)
npm run verify -- --self-test # in-process mock — proves the harness with no server
```

- Exit `0` = all checks green (endpoint reachable + CA trust + contract shape).
- Exit `1` = a check failed (e.g. `trust anchor not found`, wrong `/api/state`
  shape, or the port-forward chain is down). The per-endpoint report names the
  failure so you go straight to the right layer.
- `--insecure` skips TLS (use only for `http://` or a mock); `--base` overrides
  the target (mirrors the **Set** tab at runtime).

This script is the machine-checkable form of the contract documented below — it
reads the same endpoints `App.js` polls, so a green run means the app will
connect.

## Releases & history notes

- **v1.1.0** — endpoint persistence + connection verify (2026-09-05):
  - Base URL now persists across app restarts via `@react-native-async-storage/async-storage`.
  - Settings tab now has a "Test connection" button that pings `/api/state` and shows reachability + latency.
  - Breaking change: added `@react-native-async-storage/async-storage` dependency (lightweight, Expo-managed).
- **v1.0.0** — initial companion: dashboard, task create+dispatch, approvals,
  operator log viewer, settings.
- Network layer hardening (self-signed CA trust, NSC injection, cleartext config)
  was the focus of the first batch of commits — see `git log` for the full
  evolution, including the `huxlabs → nz1labs` rebrand.
