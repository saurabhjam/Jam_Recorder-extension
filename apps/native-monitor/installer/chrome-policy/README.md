# Restricting the share picker to "Entire screen"

The extension cannot do this itself. `getDisplayMedia` always prompts, and
Chrome ignores the `displaySurface: 'monitor'` hint when deciding which tabs
to render in the picker — it only preselects one. There is no manifest key,
permission or API that removes the Window and Chrome-tab tabs. If there were,
any extension could narrow a screen-share prompt without the user noticing.

What _does_ work is Chrome's own capture policy. Chrome supports a global deny
plus per-origin allowlists for each surface type:

| Policy                          | Grants              |
| ------------------------------- | ------------------- |
| `ScreenCaptureAllowed`          | master switch       |
| `ScreenCaptureAllowedByOrigins` | whole screens       |
| `WindowCaptureAllowedByOrigins` | application windows |
| `TabCaptureAllowedByOrigins`    | browser tabs        |

Granting the extension's origin **only** `ScreenCaptureAllowedByOrigins`
leaves whole-screen as the sole permitted surface for it, and Chrome then draws
the picker with only the "Entire screen" tab.

## Read this before deploying

`ScreenCaptureAllowed: false` is a **global** deny. Every origin not named in
one of the allowlists loses screen sharing entirely — Google Meet, Zoom in the
browser, Slack huddles, anything. That is why each config below ships an
`ALLOW_FULL_CHOICE` list: put every tool your team screen-shares from in it,
or you will break them. The list is the whole risk of this change; the
monitoring entry itself is narrow.

If that trade is not acceptable, do not deploy this. The alternative is to move
capture into the desktop agent, which needs no browser prompt and no policy at
all — ask, and it can be built.

## Verifying

After deploying, open `chrome://policy` and press "Reload policies". The four
policies should be listed with no conflicts. Then start monitoring: the picker
must show a single "Entire screen" tab.

## Extension origin

`chrome-extension://heogonedpcjllemcclnbedlgnnijhloi`

Pinned by the `key` in the extension manifest, so an unpacked developer build
and a packed one share it. If that key ever changes, these files must too.
