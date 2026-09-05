# BestQ native monitoring agent

Reports the OS **foreground application** and **system-wide idle time** to the
BestQ browser extension over Chrome Native Messaging. Written in Go; ships as a
single self-contained executable with no runtime dependency on Node, Python or
Java.

## Why it exists

`chrome.tabs`, `chrome.windows` and `chrome.webNavigation` describe the browser
and nothing else. An extension cannot see VS Code, Slack, a terminal, or a tab
in a **different Chrome profile** — so it cannot answer "which application was
in use, and for how long", and it must not claim to. This process asks the OS.

It is also the only honest source for inactivity. `chrome.idle` reports that a
threshold was _crossed_; it cannot report a duration. So a 22-minute absence
would be recorded as the 5-minute threshold. The agent reads the OS idle counter
and reports the real 22 minutes.

## Architecture

```
Chrome Extension  ──Native Messaging──▶  Native Agent
      │                                       │
      │                                  ┌────┴─────┬──────────┐
      │                              Windows     macOS      Linux
      │                            (user32)   (NSWorkspace  (xdotool/
      │                                        + AX API)    xprintidle)
      │
      └──HTTPS (its own authenticated session)──▶  BestQ Backend  ──▶  Report Portal
```

The agent holds **no credentials** and makes **no network connections**. It
reports activity metadata to the extension, which sends it to the backend using
the session the user is already authenticated for. That is deliberate: a
long-lived token in a desktop process is a much larger attack surface than one
in the browser's own storage.

```
native-monitor/
  cmd/bestq-monitoring-agent/   entry point, --version / --probe
  internal/protocol/            versioned message contract + stdio framing
  internal/core/                activity intervals, idle model, privacy, logging
  internal/platform/            one file per OS behind a common interface
  installer/{macos,windows,linux}
  config/extension-ids.json     per-environment allowed origins
  test/e2e-protocol.mjs         drives the real binary over the real protocol
```

## What it collects

Per focus change: the frontmost application's name, its bundle id / executable
name, its pid, and its window title. Plus idle transitions. That is all.

**Never**: keystrokes, clipboard, window contents, page content, cookies,
tokens, passwords, the process list, files, or network traffic.

Window titles are redacted **inside the agent** before transmission
(`internal/core/privacy.go`): query strings, long opaque strings, labelled
secrets and card-shaped digit runs are replaced; titles are capped at 160
characters; and password managers / authenticators have their title dropped
entirely — the application name still carries the time.

`pageUrl` is **never** produced. A window title is not a URL, and for another
Chrome profile there is no way to obtain one. The extension pins this to `false`
in its validator so even a compromised agent cannot introduce one.

## Install (end users)

| Platform      | Artefact                                  | Registration                                                                                                                                                                         |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS 13+     | `BestQMonitoringAgent-<ver>.pkg`          | `postinstall` writes the host manifest into each browser's `NativeMessagingHosts` directory, plus a LaunchAgent that re-registers at login so a browser installed later is picked up |
| Windows 10/11 | `BestQMonitoringAgentSetup.exe`           | Inno Setup writes `HKCU\Software\{Google\Chrome,Chromium,BraveSoftware\Brave-Browser,Microsoft\Edge}\NativeMessagingHosts\com.bestq.monitoring`                                      |
| Linux (deb)   | `bestq-monitoring-agent_<ver>_<arch>.deb` | Ships the manifest into `/etc/opt/chrome/native-messaging-hosts` and the Chromium/Edge/Brave equivalents                                                                             |

No registry editing, no JSON copying, no `chmod`, no terminal commands. Restart
the browser and the extension connects.

Uninstall: `installer/macos/uninstall.sh`, Add/Remove Programs, or
`apt remove bestq-monitoring-agent`.

## Permissions

| OS            | Requirement                                                              | Without it                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS         | **Accessibility** (System Settings → Privacy & Security → Accessibility) | Application name, bundle id, pid and idle still work. Window titles do not, so `windowTitle` and `browserProfile` report `false` and the agent sends `PERMISSION_REQUIRED`.                                    |
| Windows       | none                                                                     | —                                                                                                                                                                                                              |
| Linux X11     | `xdotool`, `xprintidle` (hard `Depends`)                                 | Nothing to report; capabilities are `false`.                                                                                                                                                                   |
| Linux Wayland | **not supported**                                                        | Wayland does not expose the focused window to unprivileged clients. The agent reports `foregroundApplication: false` and the extension shows application tracking as unavailable. It does **not** invent rows. |

## Capability model

The agent probes at runtime rather than assuming from the OS name:

```json
{
  "foregroundApplication": true,
  "windowTitle": true,
  "processIdentifier": true,
  "browserProfile": true,
  "exactBrowserUrl": false,
  "idleDetection": true
}
```

Check any machine with `bestq-monitoring-agent --probe`.

## Protocol

Chrome's framing: little-endian `uint32` length, then UTF-8 JSON. Every message
carries `protocolVersion`; a mismatch is refused rather than half-parsed, and
the extension surfaces it as "Update Required".

**stdout carries framed messages only.** All diagnostics go to stderr and a
rotating log (`~/Library/Logs/BestQ`, `%LOCALAPPDATA%\BestQ\logs`,
`~/.local/state/bestq`). A single stray byte on stdout desynchronises the length
prefix and Chrome closes the port.

| Extension → agent                                    | Agent → extension                                              |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `HELLO`                                              | `READY` (version, platform, arch, capabilities, permissions)   |
| `START_MONITORING` (sessionId, idleThresholdSeconds) | `STARTED`                                                      |
| `PAUSE_MONITORING` / `RESUME_MONITORING`             | `PAUSED` / `RESUMED`                                           |
| `FLUSH`                                              | `FLUSHED` — closes the open interval at the true stop time     |
| `GET_STATUS`                                         | `STATUS`                                                       |
| `STOP_MONITORING`                                    | `STOPPED`                                                      |
|                                                      | `ACTIVITY_CHANGED`, `IDLE_CHANGED`, `HEARTBEAT` (20s), `ERROR` |

## Security model

- `allowed_origins` names exactly one extension id. **Never a wildcard** — that
  is the mechanism preventing another extension from driving the agent.
- The agent accepts no executable paths, runs no commands from the wire, and
  opens no sockets.
- Message size is capped at Chrome's 1 MiB; a bad frame length is fatal because
  every subsequent boundary would be wrong.
- Session ids are validated against a charset and length before being echoed
  into stored activity.
- The extension re-validates everything the agent sends: timestamps must be
  within a sane window, durations bounded, strings length-capped, and
  `exactBrowserUrl` / `pageUrl` pinned regardless of what arrives.

## Developer commands

```bash
npm run build              # test + all platform binaries
npm run build:native:macos # universal binary (needs a Mac: cgo)
npm run build:native:windows
npm run build:native:linux
npm run package:macos      # .pkg
npm run package:linux      # .deb (amd64 + arm64)
npm run package:windows    # prints the Inno Setup command (Windows only)
npm run test               # go test + the end-to-end protocol test
npm run probe              # print this machine's capabilities
```

## Release

macOS signing and notarisation are opt-in because the identity cannot live in
the repository:

```bash
BESTQ_SIGN_IDENTITY="Developer ID Installer: … (TEAMID)" \
BESTQ_NOTARY_PROFILE="bestq-notary" \
npm run package:macos
```

Windows signing is applied in CI via Inno Setup's `SignTool`. Both builds print
a warning and still produce an artefact when unsigned — usable for internal
distribution, **not** for release.

Extension ids per environment live in `config/extension-ids.json`. The
production id is derived from the `key` in the extension manifest, so a packed
and an unpacked build share it.

## Known limitations

1. **Wayland**: no foreground-window or idle API for unprivileged clients.
   Reported as unavailable. Not solvable without a compositor-specific portal.
2. **Exact URL in another Chrome profile**: impossible. Chrome isolates
   profiles and exposes no cross-profile API. The agent supplies browser +
   profile + window title; the screenshot is the visual record.
3. **macOS window titles need Accessibility.** Some Electron and Java apps
   expose no AX tree even with it granted; those report a name and no title.
4. **A `desktopCapture` stream id is single-use**, so if the extension's
   offscreen document is destroyed the user must re-grant the screen. Unrelated
   to this agent, but it is why capture and agent statuses are separate.
