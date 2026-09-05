# Native agent architecture

## The problem

A Chrome extension is confined to the browser. It cannot answer:

- Which application had OS focus, and for how long?
- Which page was open in a _different_ Chrome profile?
- How long has the machine actually been without input?

The first two are outside the browser. The third is technically available via
`chrome.idle`, but only as a threshold crossing — never as a duration — which
means a 22-minute absence is indistinguishable from a 6-minute one.

## The split

```
┌──────────────────────────────────────────────────────────────┐
│ Chrome Extension                                             │
│                                                              │
│  monitoring.manager.ts     session lifecycle, state machine  │
│  monitoring.capture.ts     screen grant + capture watchdog   │
│  offscreen/…capture.ts     frame grab, deadline scheduler,   │
│                            IndexedDB upload queue            │
│  monitoring.activity.ts    PAGE rows for THIS profile        │
│  native-agent.manager.ts   the one native port               │
└───────────────┬──────────────────────────────────────────────┘
                │  Chrome Native Messaging (framed JSON, stdio)
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Native Agent (Go, single binary)                             │
│                                                              │
│  protocol/      versioned contract + framing                 │
│  core/          interval engine, idle model, redaction        │
│  platform/      windows (user32) · darwin (NSWorkspace + AX) │
│                 linux (xdotool/xprintidle, X11 only)         │
└──────────────────────────────────────────────────────────────┘
                │  (no network — the agent holds no credentials)
                ▼
        Extension's authenticated session
                │
                ▼  POST /v1/{project}/monitoring/activities/batch
        BestQ Backend  ──▶  Report Portal
```

## Reconciliation: two sources, two kinds of claim

This is the rule that keeps the daily report honest.

|             | Extension                    | Native agent                                               |
| ----------- | ---------------------------- | ---------------------------------------------------------- |
| Scope       | its own Chrome profile       | the whole machine                                          |
| Row type    | `PAGE`                       | `APPLICATION`                                              |
| `source`    | `EXTENSION`                  | `NATIVE_AGENT`                                             |
| Knows       | domain, URL, page title      | application, bundle id, pid, window title, browser profile |
| Never knows | anything outside its profile | a URL                                                      |

They are stored as **separate rows with a `source` column**, never merged. A
report that merged them could not distinguish "the browser was frontmost for
three hours" from "a tab was open for three hours while the user worked in an
editor".

While the agent is connected it owns inactivity; `chrome.idle` stands down, or
one absence would open two overlapping periods.

## Inactivity: threshold ≠ duration

```
10:24  last input
10:29  five minutes elapsed → the stretch now QUALIFIES
10:46  input resumes

recorded:  10:24 → 10:46,  duration 22 minutes
```

Not `10:29 → 10:46` (discards the first five minutes of a real absence) and not
a flat "5 minutes" (discards the length). The threshold decides _whether_; the
OS idle counter decides _what_.

## Failure independence

Screen capture and the agent fail separately and are surfaced separately:

| Screen capture | Activity agent | Result                                                        |
| -------------- | -------------- | ------------------------------------------------------------- |
| Connected      | Connected      | Full monitoring                                               |
| Connected      | Not installed  | Screenshots + this profile's pages. UI offers the installer.  |
| Disconnected   | Connected      | Application activity continues. UI offers "Reconnect Screen". |
| Disconnected   | Not installed  | Session still records time; UI says both are unavailable.     |

The UI never shows "Applications: 0" for a disconnected agent — that is a
different statement from "no applications were used".
