/**
 * BestQ — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Auth lifecycle (token refresh via chrome.alarms — survives SW termination)
 *  - Recording orchestration:
 *      • desktopCapture / tabCapture → stream ID
 *      • Create and manage offscreen document for all media operations
 *      • Relay messages between popup/content-scripts and offscreen
 *  - Timer, badge, floating toolbar injection
 *  - Relay upload progress/complete from offscreen to popup
 *  - Process offline upload queue on startup
 *
 * IMPORTANT: All actual media operations (getUserMedia, MediaRecorder, AudioContext)
 * live in the offscreen document — they are NOT available in service workers.
 */

import { authManager } from './auth.manager';
import type {
  ExtensionMessage,
  RecordingOptions,
  CaptureConsoleLog,
  CaptureNetworkEntry,
  CaptureUrlEntry,
  CaptureData,
  DraftRecording,
} from '@/types';
import { STORAGE_KEYS } from '@/types';

/** Drafts list is capped at this many entries; older ones are evicted. */
const MAX_DRAFTS = 5;
import { generateId, isRestrictedUrl } from '@/utils';
import {
  configureMonitoringOffscreen,
  startMonitoringSession,
  stopMonitoringSession,
  pauseMonitoringSession,
  resumeMonitoringSession,
  loadMonitoringState,
  restoreMonitoringSession,
  handleMonitoringAlarm,
  handleMonitoringOffscreenMessage,
  noteActivePage,
  noteBrowserBlurred,
  reconnectMonitoringCapture,
  isMonitoringSessionLive,
} from './monitoring.manager';
import { MONITORING_ALARMS } from '@/types/monitoring';
import type { MonitoringInterval } from '@/types/monitoring';
import { RP_HOST, API_BASE_URL, RP_LOGIN_URL } from '@/config';

// ─── Offscreen Management ─────────────────────────────────────────────────────

const OFFSCREEN_URL = 'src/offscreen/index.html';

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      // DISPLAY_MEDIA alongside USER_MEDIA: the document captures the screen for
      // both recording and monitoring, not just the camera and microphone.
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.DISPLAY_MEDIA],
      justification: 'Screen recording, screen monitoring and webcam capture need media access',
    });
  }
}

/**
 * Close the offscreen document — unless monitoring still needs it.
 *
 * Recording calls this from five places when a recording finishes. The
 * offscreen document is also where a monitoring session's screen stream lives,
 * and closing the document destroys that stream: finishing a recording would
 * silently end screenshot capture for a monitoring session that had nothing to
 * do with it, with the UI still reporting "Monitoring Active".
 *
 * The two features share the document but not its lifetime. Monitoring is the
 * long-lived owner, so it wins — the document is left open and recording's
 * resources have already been released by its own cleanup path by this point.
 */
async function closeOffscreenDocument(): Promise<void> {
  if (isMonitoringSessionLive()) {
    console.log('[Offscreen] keeping document open — a monitoring session is using it');
    return;
  }
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) await chrome.offscreen.closeDocument();
  } catch {
    // Ignore — document may already be gone
  }
}

function sendToOffscreen(type: string, payload?: unknown): Promise<unknown> {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 250;

  const attempt = (attemptsLeft: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ target: 'offscreen', type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message ?? 'Unknown error';
          if (attemptsLeft > 0 && msg.includes('Could not establish connection')) {
            setTimeout(
              () =>
                attempt(attemptsLeft - 1)
                  .then(resolve)
                  .catch(reject),
              RETRY_DELAY_MS,
            );
          } else {
            reject(new Error(msg));
          }
          return;
        }
        if (response?.error) {
          reject(new Error(response.error as string));
          return;
        }
        resolve(response);
      });
    });

  return attempt(MAX_ATTEMPTS);
}

// Monitoring owns its own session lifecycle but has no business duplicating the
// offscreen document's create/close bookkeeping, so it is handed the two calls
// it needs and nothing else.
configureMonitoringOffscreen({
  ensureDocument: ensureOffscreenDocument,
  send: sendToOffscreen,
});

// Run on every worker start, not only `onStartup` — the worker is woken by
// alarms, messages and navigation events far more often than by a browser
// launch, and a live session needs its alarm and idle listener back each time.
void restoreMonitoringSession();

// ─── Recording State ──────────────────────────────────────────────────────────

let currentRecordingId: string | null = null;
let currentRecordingOptions: RecordingOptions | null = null;
let currentRecordingTabId: number | null = null;
let elapsedSeconds = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let isRecordingActive = false;
let isPaused = false;
// A stop is underway. Makes STOP_RECORDING idempotent, and — just as importantly —
// stops restoreStateFromStorage from reading a recording back into memory while its
// teardown is mid-flight. Worker-lifetime only, which is the correct scope: if the
// worker dies mid-stop, the persisted record is already gone (see handleStopRecording),
// so nothing is left to resurrect.
let stopInFlight = false;

// The Chrome window we last saw actually holding OS-level focus (kept in sync by
// chrome.windows.onFocusChanged / chrome.tabs.onActivated AND re-derived fresh
// every poll tick from chrome.windows.getAll — see pollAllWindowsDuringScreenRecording).
// `tab.active` is scoped PER WINDOW: every open window always has exactly one
// active tab regardless of whether that window has real OS focus, so filtering
// only on `tab.active` (the previous approach) swept every unfocused window's
// permanently-active tab into the captured list every tick — the reintroduced
// "unrelated background tabs appear" noise bug. Tracking which window is truly
// focused, and only trusting THAT window's active tab, fixes it.
let lastFocusedWindowId: number | null = null;

// URLs visited by the recorded tab (or, for screen shares, whichever tab is
// focused — the presenter can be seen tabbing between sites on screen).
let visitedUrls: CaptureUrlEntry[] = [];

// Last URL recorded PER TAB. Dedup must be keyed per-tab, not against just the
// single most-recent global entry: with multiple windows polled every second,
// entries for different tabs interleave (tabA, tabB, tabA, tabB, ...) and a
// "compare to the last pushed entry" check never catches tabA repeating itself
// because the last entry by then belongs to tabB — producing constant duplicate
// spam of the same unchanged URL every poll tick.
const lastUrlByTab = new Map<number, string>();

// ─── CDP Session Storage Key ──────────────────────────────────────────────────
// Declared early — used in both restoreStateFromStorage (below) and the CDP
// capture state section. Session storage survives SW suspension within a browser
// session, so captures are preserved even if the SW is killed mid-recording.
const CDP_SESSION_KEY = 'st_cdp_captures';

// ─── State Restore (after SW termination) ────────────────────────────────────

async function restoreStateFromStorage(): Promise<void> {
  if (isRecordingActive) return;
  // Mid-teardown: `isRecordingActive` has already been cleared but the recording is
  // still being finalized. Restoring here would bring the timer, the URL poll and
  // the toolbar re-injection back up on top of a stop in progress.
  if (stopInFlight) return;
  const [localStored, sessionStored] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.RECORDING_STATE]),
    chrome.storage.session.get([CDP_SESSION_KEY]),
  ]);
  const state = localStored[STORAGE_KEYS.RECORDING_STATE] as
    | {
        isRecording: boolean;
        recordingId: string;
        options: RecordingOptions;
        startedAt: number;
        tabId?: number;
      }
    | undefined;
  if (!state?.isRecording) return;
  isRecordingActive = true;
  currentRecordingId = state.recordingId;
  currentRecordingOptions = state.options;
  currentRecordingTabId = state.tabId ?? null;
  elapsedSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
  if (!timerInterval) startTimer();

  // Which tabs currently carry a toolbar — in-memory only, so it must be reloaded
  // here or a stop after this restart leaves toolbars behind on every tab visited
  // in an earlier worker instance.
  await loadPersistedToolbarTabs();

  // Restore CDP captures that were flushed to session storage before SW suspended
  const captures = sessionStored[CDP_SESSION_KEY] as
    | {
        consoleLogs: CaptureConsoleLog[];
        networkEntries: CaptureNetworkEntry[];
        visitedUrls?: CaptureUrlEntry[];
      }
    | undefined;
  if (captures) {
    cdpConsoleLogs = captures.consoleLogs ?? [];
    cdpNetworkEntries = captures.networkEntries ?? [];
    visitedUrls = captures.visitedUrls ?? [];
    lastUrlByTab.clear();
    for (const entry of visitedUrls) lastUrlByTab.set(entry.tabId, entry.url);
    console.log(
      `[CDP] Restored ${cdpConsoleLogs.length} logs, ${cdpNetworkEntries.length} network entries, ${visitedUrls.length} visited URLs from session storage after SW restart`,
    );
  }

  // Re-attach CDP so captures continue after SW suspension
  if (currentRecordingTabId) {
    console.log(`[Background] SW reactivated — re-attaching CDP to tab ${currentRecordingTabId}`);
    void reattachDebugger(currentRecordingTabId);
  }
}

// Several listeners (tab switch, window focus, navigation, tab update) can all
// fire back-to-back right when the service worker wakes from suspension. Each
// independently guarding `if (!isRecordingActive) await restoreStateFromStorage()`
// is a race: two concurrent calls both see isRecordingActive as false, both
// re-read the last flushed session-storage snapshot, and whichever resolves
// LAST wholesale-overwrites in-memory arrays (visitedUrls, cdpConsoleLogs,
// cdpNetworkEntries), discarding anything the other one pushed in between.
// Routing every caller through this single in-flight promise means they all
// await the SAME restore instead of racing separate ones.
let restoreInFlight: Promise<void> | null = null;
function ensureRecordingStateRestored(): Promise<void> {
  if (isRecordingActive) return Promise.resolve();
  if (!restoreInFlight) {
    restoreInFlight = restoreStateFromStorage().finally(() => {
      restoreInFlight = null;
    });
  }
  return restoreInFlight;
}

// ─── CDP Capture State ────────────────────────────────────────────────────────

let cdpTabId: number | null = null;
let cdpConsoleLogs: CaptureConsoleLog[] = [];
// requestId → partial entry (finalised on loadingFinished/loadingFailed)
const cdpNetworkMap = new Map<string, Partial<CaptureNetworkEntry> & { startedAt: number }>();
let cdpNetworkEntries: CaptureNetworkEntry[] = [];
// Holds merged capture data between stopRecording and OFFSCREEN_RECORDING_READY
let pendingCaptureData: CaptureData | null = null;

// Debounced flush — writes CDP arrays to session storage at most once per 2s.
// Preserves captures across SW suspension without hammering storage on every
// high-frequency network event.
let _captureFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCaptureFlush(): void {
  if (_captureFlushTimer) return;
  _captureFlushTimer = setTimeout(() => {
    _captureFlushTimer = null;
    if (!isRecordingActive) return;
    // Trim response bodies in the persisted copy so 1000 entries stay well
    // under the chrome.storage.session quota; in-memory entries keep full bodies.
    const trimmedEntries = cdpNetworkEntries
      .slice(-1000)
      .map((e) =>
        e.responseBody && e.responseBody.length > 5_000
          ? { ...e, responseBody: e.responseBody.slice(0, 5_000), responseBodyTruncated: true }
          : e,
      );
    void chrome.storage.session
      .set({
        [CDP_SESSION_KEY]: {
          consoleLogs: cdpConsoleLogs.slice(-1000),
          networkEntries: trimmedEntries,
          visitedUrls: visitedUrls.slice(-500),
        },
      })
      .catch(() => {});
  }, 2000);
}

// Response bodies are only captured for text-like payloads (API responses),
// capped per-entry so captures stay within storage/upload limits.
const MAX_CAPTURE_BODY_CHARS = 50_000;
const TEXT_BODY_MIME = /json|text|xml|javascript|x-www-form-urlencoded|graphql/i;

function fetchCdpResponseBody(
  tabId: number | undefined,
  requestId: string,
  entry: CaptureNetworkEntry,
): void {
  if (tabId === undefined || tabId !== cdpTabId) return;
  if (!entry.mimeType || !TEXT_BODY_MIME.test(entry.mimeType)) return;
  chrome.debugger
    .sendCommand({ tabId }, 'Network.getResponseBody', { requestId })
    .then((result) => {
      const r = result as { body?: string; base64Encoded?: boolean } | undefined;
      if (!r?.body) return;
      let body = r.body;
      if (r.base64Encoded) {
        try {
          body = atob(body);
        } catch {
          return; // not decodable text — skip
        }
      }
      entry.responseBodyTruncated = body.length > MAX_CAPTURE_BODY_CHARS;
      entry.responseBody = body.slice(0, MAX_CAPTURE_BODY_CHARS);
      scheduleCaptureFlush();
    })
    .catch(() => {
      // Body no longer available (navigation, detach, or non-cacheable) — non-fatal
    });
}

async function attachDebugger(tabId: number): Promise<void> {
  // Cancel any pending flush and clear stale session captures from a prior recording
  if (_captureFlushTimer) {
    clearTimeout(_captureFlushTimer);
    _captureFlushTimer = null;
  }
  void chrome.storage.session.remove([CDP_SESSION_KEY]).catch(() => {});

  cdpTabId = tabId;
  cdpConsoleLogs = [];
  cdpNetworkMap.clear();
  cdpNetworkEntries = [];
  console.log(`[CDP] Attaching to tab ${tabId}`);
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Log.enable', {}),
    ]);
    console.log(`[CDP] Attached and domains enabled on tab ${tabId}`);
  } catch (err) {
    console.warn('[CDP] Attach failed (non-fatal) — falling back to content-script capture:', err);
    cdpTabId = null;
  }
}

async function detachDebugger(): Promise<void> {
  if (cdpTabId === null) return;
  const tabId = cdpTabId;
  cdpTabId = null;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached (e.g. tab closed)
  }
}

// Re-attach after navigation without clearing accumulated captures.
async function reattachDebugger(tabId: number): Promise<void> {
  const prevTabId = cdpTabId;
  cdpTabId = null;
  if (prevTabId !== null) {
    try {
      await chrome.debugger.detach({ tabId: prevTabId });
    } catch {
      // May have already auto-detached on cross-origin navigation
    }
  }
  cdpTabId = tabId;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Log.enable', {}),
    ]);
  } catch (err) {
    console.warn('[Background] CDP re-attach after navigation failed (non-fatal):', err);
    cdpTabId = null;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== cdpTabId) return;
  const p = params as Record<string, unknown>;

  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = p['request'] as
        | {
            url: string;
            method: string;
            headers?: Record<string, string>;
            postData?: string;
          }
        | undefined;
      const init = p['initiator'] as { type?: string } | undefined;
      if (!req) break;
      cdpNetworkMap.set(p['requestId'] as string, {
        id: p['requestId'] as string,
        url: req.url,
        method: req.method.toUpperCase(),
        status: 0,
        statusText: '',
        duration: 0,
        timestamp: Date.now(),
        startedAt: Date.now(),
        size: 0,
        initiator: init?.type,
        requestHeaders: req.headers,
        requestBody: req.postData?.slice(0, MAX_CAPTURE_BODY_CHARS),
        source: 'cdp',
      });
      break;
    }

    case 'Network.responseReceived': {
      const res = p['response'] as
        | {
            status: number;
            statusText: string;
            mimeType: string;
            headers?: Record<string, string>;
          }
        | undefined;
      const entry = cdpNetworkMap.get(p['requestId'] as string);
      if (entry && res) {
        entry.status = res.status;
        entry.statusText = res.statusText;
        entry.mimeType = res.mimeType;
        entry.responseHeaders = res.headers;
      }
      break;
    }

    case 'Network.loadingFinished': {
      const requestId = p['requestId'] as string;
      const entry = cdpNetworkMap.get(requestId);
      if (entry) {
        entry.size = (p['encodedDataLength'] as number | undefined) ?? 0;
        entry.duration = Date.now() - entry.startedAt;
        cdpNetworkEntries.push(entry as CaptureNetworkEntry);
        cdpNetworkMap.delete(requestId);
        scheduleCaptureFlush();
        fetchCdpResponseBody(source.tabId, requestId, entry as CaptureNetworkEntry);
      }
      break;
    }

    case 'Network.loadingFailed': {
      const entry = cdpNetworkMap.get(p['requestId'] as string);
      if (entry) {
        entry.failed = true;
        entry.errorText = (p['errorText'] as string | undefined) ?? 'Network error';
        entry.duration = Date.now() - entry.startedAt;
        cdpNetworkEntries.push(entry as CaptureNetworkEntry);
        cdpNetworkMap.delete(p['requestId'] as string);
        scheduleCaptureFlush();
      }
      break;
    }

    case 'Runtime.consoleAPICalled': {
      const args =
        (p['args'] as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      const message = args
        .map((a) => {
          const v = a.value ?? a.description ?? '';
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        })
        .join(' ');
      cdpConsoleLogs.push({
        level: ((p['type'] as string | undefined) ?? 'log') as CaptureConsoleLog['level'],
        message,
        timestamp: Date.now(),
        url: '',
        source: 'cdp',
      });
      scheduleCaptureFlush();
      break;
    }

    case 'Runtime.exceptionThrown': {
      const details = p['exceptionDetails'] as
        | { text: string; url?: string; exception?: { description?: string } }
        | undefined;
      if (details) {
        cdpConsoleLogs.push({
          level: 'error',
          message: details.exception?.description ?? details.text,
          timestamp: Date.now(),
          url: details.url ?? '',
          source: 'cdp',
        });
        scheduleCaptureFlush();
      }
      break;
    }

    case 'Log.entryAdded': {
      const entry = p['entry'] as { level: string; text: string; url?: string } | undefined;
      if (entry) {
        cdpConsoleLogs.push({
          level: (entry.level as CaptureConsoleLog['level']) ?? 'log',
          message: entry.text,
          timestamp: Date.now(),
          url: entry.url ?? '',
          source: 'cdp',
        });
        scheduleCaptureFlush();
      }
      break;
    }
  }
});

// ─── Badge ────────────────────────────────────────────────────────────────────

function setBadge(text: string, color: string): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge(): void {
  chrome.action.setBadgeText({ text: '' });
}

// ─── Timer ────────────────────────────────────────────────────────────────────

/**
 * Poll-based backstop for a screen/window/entire-screen recording.
 *
 * A tab's own `active` flag means "frontmost tab of ITS window" — it says
 * NOTHING about whether that window itself has real OS focus. Every open
 * window always has exactly one active tab, focused or not. Filtering only by
 * `tab.active` (the previous approach) therefore swept every unfocused
 * window's own permanently-active tab into the captured list on every tick —
 * that's the actual mechanism behind "unrelated background tabs that were
 * never visited show up": a second real Chrome window sitting untouched in
 * the background still reports its own tab as `active`, and a plain
 * `tabs.query({active:true})` includes it right alongside the tab the user is
 * genuinely looking at.
 *
 * Fix: ask Chrome directly which WINDOW currently has focus
 * (`chrome.windows.getAll` → each window's own `focused` boolean, a value
 * queried fresh every call, not an event that can be missed) and only trust
 * THAT window's active tab as "what the user is looking at" this tick. This
 * also makes the poll a genuinely independent backstop against the
 * documented real-world unreliability of the onFocusChanged/onActivated
 * EVENTS themselves (e.g. crbug 391471 — the event doesn't always fire, but
 * re-querying live state every second doesn't depend on the event firing).
 * If no Chrome window currently reports `focused` (e.g. focus is briefly on
 * a native picker/dialog, or on a non-Chrome app), fall back to the last
 * window we know was genuinely focused rather than dropping tracking, or —
 * failing that — the very first poll after a fresh SW wake before any focus
 * signal has been observed — the recording's own starting tab.
 */
async function pollAllWindowsDuringScreenRecording(): Promise<void> {
  if (!isRecordingActive || stopInFlight || currentRecordingOptions?.type !== 'screen') return;
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    const focusedWindow = windows.find((w) => w.focused) ?? null;
    if (focusedWindow?.id != null) lastFocusedWindowId = focusedWindow.id;

    const targetWindow = focusedWindow ?? windows.find((w) => w.id === lastFocusedWindowId) ?? null;
    const activeTab = targetWindow?.tabs?.find((t) => t.active);

    console.log(
      `[URL-DEBUG] poll tick — ${windows.length} window(s), focused=${focusedWindow?.id ?? 'none'}, tracking window=${targetWindow?.id ?? 'none'}:`,
      activeTab ? { tabId: activeTab.id, windowId: activeTab.windowId, url: activeTab.url } : null,
    );

    if (activeTab?.id) {
      void ensureToolbarOnActiveTab(activeTab.id);
      void recordVisitedUrl(activeTab.id, activeTab.url);
    }
  } catch (err) {
    console.log('[URL-DEBUG] poll tick threw:', err);
  }
}

// Does NOT reset elapsedSeconds — it is also used to resume after a pause and
// after a SW restore, where the accumulated time must be kept. Recording start
// resets the counter explicitly.
function startTimer(): void {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    broadcastToAll({ type: 'UPDATE_TIMER', payload: { duration: elapsedSeconds } });
    void pollAllWindowsDuringScreenRecording();
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ─── Alarm-Based Backstop (survives full SW suspension) ───────────────────────
// setInterval is NOT reliable for this: Chrome's MV3 service workers can be
// torn down after ~30s of no extension-API activity, and a pending setInterval
// is pure in-memory JS state — it is lost forever on teardown and Chrome does
// NOT restart it. So during a quiet stretch (the user just reading in another
// window, no clicks/navigation to trigger any event) the 1-second poll above
// can silently stop running entirely, with nothing to revive it. chrome.alarms
// is the MV3-native fix: Chrome guarantees it wakes the service worker (even
// from a full stop) to deliver the alarm, at the cost of a 1-minute minimum
// period (a Chrome-enforced floor — anything shorter is clamped up to it).
const URL_POLL_ALARM = 'st_url_poll_alarm';

chrome.alarms.onAlarm.addListener((alarm) => {
  // Monitoring's periodic upkeep — heartbeat, activity flush, capture watchdog.
  // An alarm is the only timer that survives the worker being torn down, which
  // it will be many times over an eight-hour session.
  if (alarm.name === MONITORING_ALARMS.TICK) {
    void handleMonitoringAlarm();
    return;
  }
  if (alarm.name !== URL_POLL_ALARM) return;
  void (async () => {
    await ensureRecordingStateRestored();
    if (isRecordingActive && !timerInterval) startTimer();
    void pollAllWindowsDuringScreenRecording();
  })();
});

function broadcastToAll(message: ExtensionMessage): void {
  // Popup / extension pages
  chrome.runtime.sendMessage(message).catch(() => {});

  // Active tab content scripts in every window — `currentWindow: true` has no
  // meaningful value from a service worker (there is no "current" window in
  // this context), so it silently reached only whatever window Chrome happened
  // to resolve that to. During a multi-window screen recording, a toolbar can
  // be mounted in several windows at once (see pollAllWindowsDuringScreenRecording)
  // and each one needs its own timer/pause-state updates. Tabs with no mounted
  // toolbar just no-op on the message (caught below), so this is harmless for
  // a single-tab recording too.
  chrome.tabs.query({ active: true }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

// ─── Main-World Capture Script ────────────────────────────────────────────────
// Injected via chrome.scripting.executeScript (world: MAIN) so it runs in the
// page's JS context and bypasses any Content Security Policy restrictions.
// Must be a self-contained function — no references to outer closure variables.

function captureScriptMain(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__stCapture) return;
  w.__stCapture = true;

  const _post = (data: object): void => window.postMessage({ __st: true, ...data }, '*');

  const MAX_BODY = 50_000;
  const TEXT_MIME = /json|text|xml|javascript|x-www-form-urlencoded|graphql/i;

  // ── XHR ──────────────────────────────────────────────────────────────────
  const _OrigXHR = w.XMLHttpRequest as typeof XMLHttpRequest;
  w.XMLHttpRequest = function (): XMLHttpRequest {
    const xhr = new _OrigXHR();
    const meta = { url: '', method: 'GET', start: 0, reqHeaders: {} as Record<string, string> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _origOpen = (xhr.open as any).bind(xhr) as (...a: unknown[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (xhr as any).open = (...args: unknown[]): void => {
      meta.method = String(args[0] ?? 'GET').toUpperCase();
      meta.url = String(args[1] ?? '');
      _origOpen(...args);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _origSetHeader = (xhr.setRequestHeader as any).bind(xhr) as (
      name: string,
      value: string,
    ) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (xhr as any).setRequestHeader = (name: string, value: string): void => {
      meta.reqHeaders[name] = value;
      _origSetHeader(name, value);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _origSend = (xhr.send as any).bind(xhr) as (...a: unknown[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (xhr as any).send = (...args: unknown[]): void => {
      meta.start = Date.now();
      const reqBody = typeof args[0] === 'string' ? args[0].slice(0, MAX_BODY) : undefined;
      xhr.addEventListener('loadend', () => {
        const resHeaders: Record<string, string> = {};
        try {
          xhr
            .getAllResponseHeaders()
            .trim()
            .split(/[\r\n]+/)
            .forEach((line) => {
              const idx = line.indexOf(': ');
              if (idx > 0) resHeaders[line.slice(0, idx)] = line.slice(idx + 2);
            });
        } catch {
          /* headers unavailable */
        }
        let resBody: string | undefined;
        try {
          const ct = xhr.getResponseHeader('content-type') ?? '';
          if ((xhr.responseType === '' || xhr.responseType === 'text') && TEXT_MIME.test(ct)) {
            resBody = xhr.responseText.slice(0, MAX_BODY);
          }
        } catch {
          /* body unavailable */
        }
        _post({
          kind: 'network',
          url: meta.url,
          method: meta.method,
          status: xhr.status,
          statusText: xhr.statusText,
          duration: Date.now() - meta.start,
          size: parseInt(xhr.getResponseHeader('content-length') ?? '0') || 0,
          timestamp: meta.start,
          failed: xhr.status === 0,
          requestHeaders: meta.reqHeaders,
          responseHeaders: resHeaders,
          requestBody: reqBody,
          responseBody: resBody,
        });
      });
      _origSend(...args);
    };
    return xhr;
  };
  w.XMLHttpRequest.prototype = _OrigXHR.prototype;

  // ── fetch ─────────────────────────────────────────────────────────────────
  const _origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const reqHeaders: Record<string, string> = {};
    try {
      const h = init?.headers ?? (input instanceof Request ? input.headers : undefined);
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          reqHeaders[k] = v;
        });
      } else if (Array.isArray(h)) {
        h.forEach(([k, v]) => {
          reqHeaders[k] = v;
        });
      } else if (h) {
        Object.assign(reqHeaders, h as Record<string, string>);
      }
    } catch {
      /* headers unavailable */
    }
    const reqBody = typeof init?.body === 'string' ? init.body.slice(0, MAX_BODY) : undefined;
    const t = Date.now();
    return _origFetch(input, init).then(
      (r: Response): Response => {
        const resHeaders: Record<string, string> = {};
        r.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });
        const ct = r.headers.get('content-type') ?? '';
        const bodyPromise: Promise<string | undefined> = TEXT_MIME.test(ct)
          ? r
              .clone()
              .text()
              .then((txt): string => txt.slice(0, MAX_BODY))
              .catch((): undefined => undefined)
          : Promise.resolve(undefined);
        void r
          .clone()
          .arrayBuffer()
          .catch((): ArrayBuffer => new ArrayBuffer(0))
          .then((buf: ArrayBuffer): void => {
            void bodyPromise.then((resBody): void => {
              _post({
                kind: 'network',
                url,
                method,
                status: r.status,
                statusText: r.statusText,
                duration: Date.now() - t,
                size: buf.byteLength,
                timestamp: t,
                failed: false,
                requestHeaders: reqHeaders,
                responseHeaders: resHeaders,
                requestBody: reqBody,
                responseBody: resBody,
              });
            });
          });
        return r;
      },
      (e: unknown): never => {
        _post({
          kind: 'network',
          url,
          method,
          status: 0,
          statusText: '',
          duration: Date.now() - t,
          size: 0,
          timestamp: t,
          failed: true,
          errorText: e instanceof Error ? e.message : String(e),
        });
        throw e;
      },
    );
  };

  // ── console ───────────────────────────────────────────────────────────────
  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((lvl) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _orig = (console as any)[lvl].bind(console) as (...a: unknown[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (console as any)[lvl] = (...args: unknown[]): void => {
      _orig(...args);
      _post({
        kind: 'console',
        level: lvl,
        message: args
          .map((a): string => {
            try {
              return typeof a === 'object' ? JSON.stringify(a) : String(a);
            } catch {
              return String(a);
            }
          })
          .join(' '),
        timestamp: Date.now(),
        url: location.href,
      });
    };
  });

  window.addEventListener('error', (ev: ErrorEvent): void => {
    _post({
      kind: 'console',
      level: 'error',
      message: ev.message || String(ev),
      timestamp: Date.now(),
      url: location.href,
    });
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent): void => {
    const msg = (ev.reason as Error | undefined)?.message ?? String(ev.reason);
    _post({
      kind: 'console',
      level: 'error',
      message: `Unhandled rejection: ${msg}`,
      timestamp: Date.now(),
      url: location.href,
    });
  });
}

async function injectMainWorldCaptureScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: captureScriptMain,
    });
  } catch (err) {
    console.warn('[Background] Main-world capture injection failed (non-fatal):', err);
  }
}

// ─── Floating Toolbar ─────────────────────────────────────────────────────────

// Every tab the toolbar has actually been confirmed mounted on during the
// CURRENT recording. A screen/entire-screen recording can show it in several
// windows at once (see pollAllWindowsDuringScreenRecording) — hideFloatingToolbar
// must clear it from all of them, not just `currentRecordingTabId`, or it's left
// stuck on screen in every window but the one that started the recording.
const toolbarShownOnTabs = new Set<number>();

// Mirrored into session storage because the Set above is plain in-memory state: an
// MV3 worker is torn down repeatedly during a long recording, and every restart
// used to bring it back EMPTY. hideFloatingToolbar then only cleaned up the handful
// of tabs touched since the last wake, leaving a live toolbar stuck on every other
// tab the user had visited — with no recording behind it, and no way to dismiss it.
const TOOLBAR_TABS_SESSION_KEY = 'st_toolbar_tabs';

function persistToolbarTabs(): void {
  void chrome.storage.session
    .set({ [TOOLBAR_TABS_SESSION_KEY]: Array.from(toolbarShownOnTabs) })
    .catch(() => {});
}

async function loadPersistedToolbarTabs(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get([TOOLBAR_TABS_SESSION_KEY]);
    for (const id of (stored[TOOLBAR_TABS_SESSION_KEY] as number[] | undefined) ?? []) {
      toolbarShownOnTabs.add(id);
    }
  } catch {
    /* session storage unavailable — the all-tabs sweep in hideFloatingToolbar covers us */
  }
}

function markToolbarShown(tabId: number): void {
  if (toolbarShownOnTabs.has(tabId)) return;
  toolbarShownOnTabs.add(tabId);
  persistToolbarTabs();
}

// Last time we programmatically re-injected the content script into a tab.
//
// This used to be unthrottled, and it is the engine behind the blinking toolbar:
// pollAllWindowsDuringScreenRecording calls injectFloatingToolbar once a SECOND,
// and any answer that wasn't `mounted: true` — including entirely transient ones,
// like a mount deferred because <body> didn't exist yet — dropped straight through
// to executeScript. Each of those injections spawned another live content-script
// instance, and the instances then fought over the single toolbar node, which
// produced *more* not-mounted answers, which triggered *more* injections. A
// self-accelerating loop, which is exactly why it got worse the longer a recording
// ran. Injection is now both throttled and reserved for the one case that actually
// needs it: no content script listening in that tab at all.
const lastInjectionAtByTab = new Map<number, number>();
const REINJECT_COOLDOWN_MS = 10_000;

async function injectFloatingToolbar(targetTabId?: number): Promise<boolean> {
  let tabId = targetTabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (!tabId) return false;
  // Last line of defence: never mount for a recording that is being torn down.
  if (!isRecordingActive || stopInFlight || !currentRecordingId) return false;
  const targetTab = tabId;

  const showMsg = {
    type: 'SHOW_TOOLBAR' as const,
    payload: { recordingId: currentRecordingId },
  } satisfies ExtensionMessage;

  // The content script answers with `mounted` = the toolbar is actually in the
  // live DOM. A delivered message alone is NOT success — the mount can silently
  // fail (no <body> yet, page evicted the node) and callers use this result to
  // decide whether the popup may close. `delivered` separates "the content script
  // answered, it just hasn't mounted yet" from "nothing is listening in this tab";
  // only the latter justifies re-injecting the script.
  const sendShow = async (): Promise<{ mounted: boolean; delivered: boolean }> => {
    try {
      const res = (await chrome.tabs.sendMessage(targetTab, showMsg)) as
        | { mounted?: boolean }
        | undefined;
      return { mounted: res?.mounted === true, delivered: true };
    } catch {
      return { mounted: false, delivered: false };
    }
  };

  // Try messaging first (content script already running)
  const first = await sendShow();
  if (first.mounted) {
    markToolbarShown(targetTab);
    return true;
  }
  if (first.delivered) {
    // The content script is alive and has the request; the mount is just pending
    // (deferred to DOMContentLoaded, or racing a page that just wiped the node).
    // Its own watchdog completes it — re-injecting here would only add a rival
    // instance. Still tracked, so the tab is swept on stop.
    markToolbarShown(targetTab);
    return false;
  }

  // Nothing listening in this tab. Inject the script — but not more often than the
  // cooldown, so a page where injection can never succeed (restricted URL, a
  // sandboxed frame) can't be hammered once a second for the whole recording.
  const lastInjection = lastInjectionAtByTab.get(targetTab) ?? 0;
  if (Date.now() - lastInjection < REINJECT_COOLDOWN_MS) return false;
  lastInjectionAtByTab.set(targetTab, Date.now());

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/index.js'],
    });
    await new Promise<void>((r) => setTimeout(r, 150));
    const retry = await sendShow();
    if (retry.delivered) markToolbarShown(targetTab);
    return retry.mounted;
  } catch (err) {
    console.error('[Background] Could not inject toolbar into tab', tabId, err);
    return false;
  }
}

/** Is the toolbar genuinely in the live DOM of this tab? Read-only — never mounts,
 *  never injects. Lets the poll skip tabs that are already fine. */
async function isToolbarLiveOnTab(tabId: number): Promise<boolean> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: 'TOOLBAR_STATUS',
    } satisfies ExtensionMessage)) as { mounted?: boolean } | undefined;
    return res?.mounted === true;
  } catch {
    return false; // no content script listening
  }
}

/**
 * Remove the toolbar from every tab except `keepTabId`.
 *
 * A screen/entire-screen recording surfaces the controls on whatever tab the user
 * switches to, but nothing ever took them off the tab they left — so after moving
 * through a few tabs the stop/pause bar was sitting on all of them at once, each
 * with its own timer. Only the tab actually in front of the user needs it.
 */
async function pruneToolbarsExcept(keepTabId: number): Promise<void> {
  const stale = Array.from(toolbarShownOnTabs).filter((id) => id !== keepTabId);
  if (stale.length === 0) return;
  const hideMsg = { type: 'HIDE_TOOLBAR' } satisfies ExtensionMessage;
  await Promise.all(
    stale.map(async (tabId) => {
      try {
        await chrome.tabs.sendMessage(tabId, hideMsg);
      } catch {
        /* tab closed or has no content script — nothing to hide */
      }
      toolbarShownOnTabs.delete(tabId);
    }),
  );
  persistToolbarTabs();
}

// Re-inject toolbar after navigation (page reload, SPA route change, etc.)
async function reinjectToolbarIntoTab(tabId: number): Promise<void> {
  await ensureRecordingStateRestored();
  if (!isRecordingActive || stopInFlight) return;

  // A tab recording captures only its own tab, so the toolbar stays pinned there
  // and is never pushed onto other tabs. A screen/window share captures whatever
  // is on screen, so the toolbar follows the user to whatever tab they navigate.
  if (currentRecordingOptions?.type !== 'screen' && currentRecordingTabId !== tabId) return;

  await injectFloatingToolbar(tabId);

  // Capture (CDP + main-world hooks) follows only the tab being recorded:
  //  • screen/window share → follow the user across tabs (capture is global)
  //  • tab recording → stay pinned to the recording tab, so navigating a
  //    different tab never steals capture from the recorded one.
  // CDP auto-detaches on cross-origin navigation, so we re-attach here to keep
  // captures uninterrupted; accumulated entries are preserved. Skipped when the
  // user disabled DevTools capture for this recording.
  const captureThisTab =
    currentRecordingOptions?.type === 'screen' || currentRecordingTabId === tabId;
  if (captureThisTab && currentRecordingOptions?.captureDevtools !== false) {
    void reattachDebugger(tabId);
    void injectMainWorldCaptureScript(tabId);
  }
}

// Surface the toolbar when the user switches to an already-loaded tab or another
// browser window during a recording. Such a switch fires no navigation event, so
// the content script won't self-mount the toolbar — we push SHOW_TOOLBAR
// (injecting the content script first if it isn't there). Toolbar only: capture
// stays where it is (a tab recording keeps capturing its tab; a screen recording
// re-attaches CDP through the navigation handler).
// Serialises the "which tab should hold the toolbar" decision. The poll tick,
// tabs.onActivated and windows.onFocusChanged can all answer that question at once
// while the user is switching tabs quickly — and two overlapping runs would each
// prune the other's tab, briefly leaving no toolbar anywhere. Latest caller wins.
let toolbarPlacementToken = 0;

async function ensureToolbarOnActiveTab(tabId: number): Promise<void> {
  const token = ++toolbarPlacementToken;
  const isStillCurrent = (): boolean => token === toolbarPlacementToken;

  await ensureRecordingStateRestored();
  // `stopInFlight` matters as much as `isRecordingActive` here: the teardown holds
  // `isRecordingActive` true across several awaits, and a poll tick landing in that
  // window would put the toolbar straight back onto the tab hideFloatingToolbar had
  // just cleared — the "controls survive Stop" symptom.
  if (!isRecordingActive || stopInFlight) {
    console.log(`[URL-DEBUG] ensureToolbarOnActiveTab(${tabId}) — not recording, skipping`);
    return;
  }
  // Tab recording → controls live on the recorded tab only; don't surface them on
  // other tabs (those aren't being recorded). Screen/window share → the toolbar
  // follows the user across tabs and windows.
  if (currentRecordingOptions?.type !== 'screen' && currentRecordingTabId !== tabId) {
    console.log(
      `[URL-DEBUG] ensureToolbarOnActiveTab(${tabId}) — out of scope (type=${currentRecordingOptions?.type}, recordedTab=${currentRecordingTabId})`,
    );
    return;
  }
  // Cheap read-only probe first. The toolbar is already up on this tab the vast
  // majority of ticks, and asking it to mount again every second — with a
  // content-script re-injection waiting behind any imperfect answer — is what made
  // the controls flicker and multiply. Nothing to do when it's already live.
  if (await isToolbarLiveOnTab(tabId)) {
    markToolbarShown(tabId);
    if (currentRecordingOptions?.type === 'screen' && isStillCurrent()) {
      await pruneToolbarsExcept(tabId);
    }
    return;
  }

  if (!isStillCurrent()) return; // the user has already moved on to another tab

  const injected = await injectFloatingToolbar(tabId);
  console.log(
    `[URL-DEBUG] ensureToolbarOnActiveTab(${tabId}) — injectFloatingToolbar → ${injected}`,
  );

  // Keep the controls on the tab in front of the user only — a screen recording
  // used to leave a live toolbar behind on every tab it had ever passed through.
  if (currentRecordingOptions?.type === 'screen' && isStillCurrent()) {
    await pruneToolbarsExcept(tabId);
  }
}

// ─── Visited URL Tracking ─────────────────────────────────────────────────────
// Same scope rule as the toolbar/capture: a tab recording only cares about its
// one recorded tab; a screen/window share follows the user across tabs, since
// whatever tab they switch to is visible on screen.

function tabInUrlScope(tabId: number): boolean {
  if (!isRecordingActive || stopInFlight) return false;
  return currentRecordingOptions?.type === 'screen' || currentRecordingTabId === tabId;
}

/** Record a URL visit for `tabId`, deduped against the immediately preceding entry. */
async function recordVisitedUrl(tabId: number, urlHint?: string): Promise<void> {
  // The service worker can be suspended and restarted between tab switches during
  // a long desktop/window/entire-screen recording — restore in-memory state first
  // (same as reinjectToolbarIntoTab/ensureToolbarOnActiveTab) or `isRecordingActive`
  // reads stale-false and every visit after the first gets silently dropped.
  await ensureRecordingStateRestored();
  if (!tabInUrlScope(tabId)) {
    console.log(
      `[URL-DEBUG] recordVisitedUrl(${tabId}) — out of scope (isRecordingActive=${isRecordingActive}, type=${currentRecordingOptions?.type}, recordedTab=${currentRecordingTabId})`,
    );
    return;
  }

  // Fast path: the poll now calls this for EVERY open tab each tick, and most
  // of them haven't changed since the last tick — when the caller already
  // supplies the URL (from a tabs.query result) and it matches what's on file,
  // skip the chrome.tabs.get() round trip entirely instead of doing it for
  // every unchanged tab, every second.
  if (urlHint && lastUrlByTab.get(tabId) === urlHint) return;

  let url = urlHint;
  let title = '';
  let favIconUrl: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = url ?? tab.url;
    title = tab.title ?? '';
    favIconUrl = tab.favIconUrl;
  } catch (err) {
    console.log(`[URL-DEBUG] recordVisitedUrl(${tabId}) — chrome.tabs.get failed:`, err);
    // Tab may already be gone — fall back to just the hinted URL.
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    console.log(`[URL-DEBUG] recordVisitedUrl(${tabId}) — rejected non-http(s) url:`, url);
    return;
  }

  if (lastUrlByTab.get(tabId) === url) return; // this tab hasn't changed since we last saw it
  lastUrlByTab.set(tabId, url);
  console.log(`[URL-DEBUG] recordVisitedUrl(${tabId}) — RECORDED:`, url);

  visitedUrls.push({ url, title, tabId, timestamp: Date.now(), favIconUrl });
  scheduleCaptureFlush();
}

/**
 * Take the toolbar down everywhere.
 *
 * Sweeps EVERY open tab, not just the ones we believe carry a toolbar. Our
 * bookkeeping is not trustworthy enough to scope this: `toolbarShownOnTabs` is
 * in-memory (so it's thinner than reality after any worker restart, even with the
 * session-storage mirror), and a tab can end up with a toolbar we never recorded —
 * the content script self-mounts on load via GET_STATE, entirely without us. A tab
 * with no toolbar simply no-ops on HIDE_TOOLBAR, so over-sending costs nothing,
 * while under-sending is precisely how a recording ends with stop/pause controls
 * still floating on half the user's tabs.
 */
async function hideFloatingToolbar(): Promise<void> {
  const hideMsg = { type: 'HIDE_TOOLBAR' } satisfies ExtensionMessage;
  const tabIds = new Set(toolbarShownOnTabs);
  if (currentRecordingTabId) tabIds.add(currentRecordingTabId);

  try {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id != null) tabIds.add(tab.id);
    }
  } catch {
    /* fall back to the tracked set below */
  }

  await Promise.all(
    Array.from(tabIds).map((tabId) =>
      chrome.tabs.sendMessage(tabId, hideMsg).catch(() => {
        /* ignore — tab may already be closed, or never had a toolbar mounted */
      }),
    ),
  );
  toolbarShownOnTabs.clear();
  lastInjectionAtByTab.clear();
  void chrome.storage.session.remove([TOOLBAR_TABS_SESSION_KEY]).catch(() => {});
}

// ─── desktopCapture Stream ID ─────────────────────────────────────────────────
//
// A generic `chooseDesktopMedia` helper used to live here, unused: recording
// acquires its stream through getDisplayMedia in the offscreen document, and
// monitoring needs a *screen-only* grant with its own error handling, which
// lives in `monitoring.capture.ts` next to the state it feeds. Keeping a second
// general-purpose one here would invite the two features to share a picker
// whose source list means different things to each.

function getTabStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'Tab capture failed'));
        return;
      }
      resolve(streamId);
    });
  });
}

// ─── Dynamic Tab-Audio Capture (screen/window recordings) ─────────────────────
// macOS can't capture system/window audio via getDisplayMedia, so the audio of a
// screen/window recording is built by tab-capturing browser tabs and mixing them
// in the offscreen document. To make the audio FOLLOW the selected scope — the
// picked window, or the whole browser for entire-screen — rather than just the
// starting tab, we capture every tab in scope that is (or becomes) audible, adding
// each to the live mix as it starts playing.
//
// Scope is derived from the picked surface: 'monitor' (entire screen) → all
// windows; 'window' → the Chrome window focused at record start (best effort — the
// native picker never tells the extension which window was actually chosen).

// null = dynamic capture off; 'all' = every window; a number = a single windowId.
let audioScope: 'all' | number | null = null;
// Tabs already handed to the offscreen mixer, so we don't double-capture them.
const capturedAudioTabs = new Set<number>();

function tabInAudioScope(windowId: number | undefined): boolean {
  if (audioScope === 'all') return true;
  if (typeof audioScope === 'number') return windowId === audioScope;
  return false;
}

/** Tab-capture a single tab's audio and stream it into the offscreen mixer. */
async function captureTabAudioIfNeeded(tab: chrome.tabs.Tab): Promise<void> {
  if (audioScope === null || !tab.id) return;
  if (capturedAudioTabs.has(tab.id)) return;
  if (!tabInAudioScope(tab.windowId)) return;

  capturedAudioTabs.add(tab.id); // reserve up-front so concurrent events don't race
  try {
    const streamId = await getTabStreamId(tab.id);
    await sendToOffscreen('OFFSCREEN_ADD_TAB_AUDIO', { streamId });
  } catch (err) {
    // chrome://, the Web Store, discarded tabs, etc. can't be captured — allow a
    // later retry if the tab becomes capturable.
    capturedAudioTabs.delete(tab.id);
    console.warn(`[Background] Could not add tab ${tab.id} audio:`, err);
  }
}

// Fires whenever a tab starts/stops producing sound. We only act on tabs that
// START being audible (and aren't captured yet) so newly-playing tabs join the mix.
function handleAudibleTabChange(
  _tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): void {
  if (changeInfo.audible === true) void captureTabAudioIfNeeded(tab);
}

/**
 * Begin following the recording's audio scope: capture every currently-audible tab
 * in scope now, and keep capturing tabs as they start playing until teardown.
 * The starting tab is always captured (even if silent) so a meeting whose audio
 * hasn't registered as `audible` yet is still recorded.
 */
async function setupDynamicTabAudio(
  displaySurface: string | undefined,
  startWindowId: number | null,
): Promise<void> {
  // 'monitor' = entire screen → whole browser. 'window' → the focused window.
  // Anything else (e.g. 'browser'/tab share) shouldn't reach here (it has direct
  // audio) — default to the whole browser so we still capture something.
  audioScope = displaySurface === 'window' && startWindowId != null ? startWindowId : 'all';
  capturedAudioTabs.clear();

  // Always capture the starting tab, then every audible tab in scope right now.
  try {
    const tabs = await chrome.tabs.query(audioScope === 'all' ? {} : { windowId: audioScope });
    const startTab = tabs.find((t) => t.id === currentRecordingTabId);
    const initial = tabs.filter((t) => t.audible);
    if (startTab && !initial.includes(startTab)) initial.unshift(startTab);
    for (const tab of initial) await captureTabAudioIfNeeded(tab);
  } catch (err) {
    console.warn('[Background] Initial tab-audio capture failed:', err);
  }

  chrome.tabs.onUpdated.addListener(handleAudibleTabChange);
}

/** Stop following tab audio and release listener/state. */
function teardownDynamicTabAudio(): void {
  if (audioScope === null) return;
  chrome.tabs.onUpdated.removeListener(handleAudibleTabChange);
  audioScope = null;
  capturedAudioTabs.clear();
}

// ─── START RECORDING ──────────────────────────────────────────────────────────

async function handleStartRecording(
  options: RecordingOptions,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  if (isRecordingActive) {
    sendResponse({ error: 'A recording is already in progress' });
    return;
  }
  if (stopInFlight) {
    sendResponse({ error: 'The previous recording is still being saved — try again in a moment' });
    return;
  }

  // A new recording starts from a clean slate: any leftover toolbar on any tab is
  // from a previous recording and would otherwise sit there showing a dead timer.
  await hideFloatingToolbar();

  currentRecordingId = generateId();
  currentRecordingOptions = options;

  let streamId: string | undefined;

  try {
    if (options.type === 'screen') {
      streamId = 'native-display-media';
      // Tab audio for screen/window shares is captured dynamically AFTER the
      // picker closes (see setupDynamicTabAudio) — capturing it here would race
      // the picker and let the tabCapture stream ids expire before use.
    } else if (options.type === 'tab') {
      const tabId =
        options.tabId ??
        (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
      if (!tabId) throw new Error('Could not determine active tab for capture');
      streamId = await getTabStreamId(tabId);
    }
    // webcam needs no streamId — offscreen calls getUserMedia directly
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to acquire stream';
    currentRecordingId = null;
    currentRecordingOptions = null;
    sendResponse({ error });
    return;
  }

  try {
    await ensureOffscreenDocument();

    const startResp = (await sendToOffscreen('OFFSCREEN_START_RECORDING', {
      options,
      streamId,
      recordingId: currentRecordingId,
    })) as { displaySurface?: string; needsTabAudio?: boolean } | undefined;

    isRecordingActive = true;
    isPaused = false;

    // Determine the active tab so we can attach CDP and show the toolbar
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentRecordingTabId = activeTab?.id ?? null;
    // Seed the "which window is focused" tracker so the very first poll tick
    // (before any onFocusChanged/onActivated event has fired) already knows
    // where to look instead of finding no window and skipping.
    lastFocusedWindowId = activeTab?.windowId ?? null;

    // Seed the visited-URLs list with the starting tab/page.
    visitedUrls = [];
    lastUrlByTab.clear();
    toolbarShownOnTabs.clear();
    lastInjectionAtByTab.clear();
    persistToolbarTabs();
    if (currentRecordingTabId) void recordVisitedUrl(currentRecordingTabId, activeTab?.url);

    // For screen/window shares that produced no direct audio (macOS), start
    // capturing tab audio across the selected scope — the picked window, or the
    // whole browser for entire-screen — and keep following tabs as they play.
    if (options.type === 'screen' && options.systemAudio && startResp?.needsTabAudio) {
      await setupDynamicTabAudio(startResp.displaySurface, activeTab?.windowId ?? null);
    }

    setBadge('REC', '#ef4444');
    await injectFloatingToolbar();
    elapsedSeconds = 0;
    startTimer();

    // Guaranteed-wake backstop for cross-window URL/toolbar tracking — see the
    // alarm listener above for why this exists alongside the 1s setInterval poll.
    if (options.type === 'screen') {
      chrome.alarms.create(URL_POLL_ALARM, { periodInMinutes: 1 });
    }

    // Attach Chrome Debugger (CDP) + inject main-world capture script for
    // full coverage: CDP for all traffic, scripting API for CSP-strict pages.
    // Skipped entirely when the user turned off DevTools capture for this
    // recording — then no console/network logs are collected.
    if (currentRecordingTabId && options.captureDevtools !== false) {
      void attachDebugger(currentRecordingTabId);
      void injectMainWorldCaptureScript(currentRecordingTabId);
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.RECORDING_STATE]: {
        isRecording: true,
        recordingId: currentRecordingId,
        startedAt: Date.now(),
        options,
        tabId: currentRecordingTabId,
      },
    });

    sendResponse({ recordingId: currentRecordingId });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to start recording';
    console.error('[Background] Start recording error:', err);

    isRecordingActive = false;
    isPaused = false;
    currentRecordingId = null;
    currentRecordingOptions = null;
    teardownDynamicTabAudio();
    await closeOffscreenDocument();
    void chrome.alarms.clear(URL_POLL_ALARM);

    broadcastToAll({ type: 'RECORDING_ERROR', error });
    sendResponse({ error });
  }
}

// ─── STOP RECORDING ───────────────────────────────────────────────────────────

/**
 * Entry point for every stop: the toolbar, the popup, the keyboard shortcut, and the
 * offscreen document reporting that the captured surface died.
 *
 * Owns the `stopInFlight` latch so the teardown below can never run twice
 * concurrently — and, just as importantly, can never leave the latch stuck. A stuck
 * latch would block every future recording for the life of the worker, so it is
 * released in a `finally` that no failure path can skip.
 */
async function handleStopRecording(
  sendResponse: (r: unknown) => void,
  cancel = false,
): Promise<void> {
  // A stop already running. The teardown yields many times, so a second Stop
  // (another click, the keyboard shortcut, the popup) lands in the middle of it —
  // and used to run a whole second teardown concurrently, both calling
  // OFFSCREEN_STOP_RECORDING. The second call rejects out of an offscreen document
  // that is already finalizing the file, which surfaced as a recording-failed error
  // on a recording that had in fact saved fine. Report the stop that is underway.
  if (stopInFlight) {
    sendResponse({ success: true, alreadyStopping: true });
    return;
  }

  // SW may have restarted — restore FULL in-memory state from storage, including
  // currentRecordingTabId and the CDP/URL captures accumulated before suspension
  // (chrome.storage.session[CDP_SESSION_KEY]). A long screen/window/entire-screen
  // recording routinely outlives several worker suspend/resume cycles, so by the
  // time Stop is handled it's very likely running in a freshly-woken instance —
  // restoring only isRecordingActive/currentRecordingId/currentRecordingOptions
  // (as this used to) left cdpConsoleLogs/cdpNetworkEntries/visitedUrls at their
  // fresh-module-load empty arrays, silently dropping everything captured in
  // earlier, now-dead worker instances.
  await ensureRecordingStateRestored();
  if (!isRecordingActive) {
    // Nothing to stop — but a Stop click landing here means the user is looking at
    // controls for a recording that no longer exists (a ghost toolbar left behind
    // on some tab). Answering "No active recording" and leaving it on screen is
    // what made Stop look permanently broken: the bar never went away, so the user
    // kept clicking it. Clean the page up instead, and report success.
    void chrome.alarms.clear(URL_POLL_ALARM);
    stopTimer();
    clearBadge();
    await hideFloatingToolbar();
    sendResponse({ success: true, alreadyStopped: true });
    return;
  }

  stopInFlight = true;
  let responded = false;
  const respondOnce = (r: unknown): void => {
    if (responded) return;
    responded = true;
    sendResponse(r);
  };
  try {
    await performStopRecording(respondOnce, cancel);
  } catch (err) {
    // Any unexpected failure mid-teardown. The recording itself may well have been
    // written out already, so report rather than swallow — and make sure the user
    // is not left with a live toolbar over a recording that has ended.
    console.error('[Background] Stop teardown failed:', err);
    isRecordingActive = false;
    isPaused = false;
    stopTimer();
    void chrome.alarms.clear(URL_POLL_ALARM);
    clearBadge();
    await hideFloatingToolbar().catch(() => {});
    broadcastToAll({ type: 'RECORDING_ERROR', error: 'Failed to finalize recording' });
    respondOnce({ error: 'Failed to finalize recording' });
  } finally {
    stopInFlight = false;
  }
}

async function performStopRecording(
  sendResponse: (r: unknown) => void,
  cancel: boolean,
): Promise<void> {
  // Drop the persisted record now, not at the end of the teardown. Any listener
  // that fires during one of the awaits below runs ensureRecordingStateRestored,
  // and while `isRecordingActive` is still true that's a no-op — but the moment we
  // clear it mid-teardown, a restore would read this record back and resurrect the
  // whole recording (timer, poll, toolbar re-injection) on top of a stop already in
  // progress. `stopInFlight` blocks that too; removing the record makes it moot.
  await chrome.storage.local.remove([STORAGE_KEYS.RECORDING_STATE]);

  // ── Flush content-script captures before hiding toolbar ──────────────────
  // Bounded: this talks to a page that may be wedged (a heavy SPA at the end of a
  // long recording), and chrome.tabs.sendMessage has no timeout of its own. An
  // unbounded await here stalls the whole stop — including hiding the toolbar and
  // telling the offscreen document to finalize — for as long as the page stays
  // unresponsive, which reads exactly like "Stop does nothing". CDP data covers
  // the same ground, so a skipped flush costs little.
  const flushTabId = currentRecordingTabId ?? cdpTabId;
  let contentCaptures: CaptureData = { consoleLogs: [], networkCaptures: [], visitedUrls: [] };
  if (flushTabId) {
    try {
      const flushed = (await Promise.race([
        chrome.tabs.sendMessage(flushTabId, { type: 'CAPTURE_FLUSH' }),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
      ])) as
        | { consoleLogs: CaptureConsoleLog[]; networkCaptures: CaptureNetworkEntry[] }
        | undefined;
      if (flushed) {
        contentCaptures = {
          consoleLogs: flushed.consoleLogs,
          networkCaptures: flushed.networkCaptures,
          visitedUrls: [],
        };
      }
    } catch {
      // Content script may be unresponsive; proceed with CDP data only
    }
  }

  // ── Detach CDP debugger and merge all capture data ────────────────────────
  await detachDebugger();

  // Clear session storage captures — no longer needed after stop
  if (_captureFlushTimer) {
    clearTimeout(_captureFlushTimer);
    _captureFlushTimer = null;
  }
  void chrome.storage.session.remove([CDP_SESSION_KEY]).catch(() => {});

  // Merge CDP + content-script captures. CDP is authoritative; content-script
  // entries are included only when no CDP entry matches (same url/level+message
  // within a 500 ms window), catching anything CDP missed during attach gaps.
  const cdpLogKeys = new Set(
    cdpConsoleLogs.map((l) => `${l.level}|${l.message}|${Math.floor(l.timestamp / 500)}`),
  );
  const mergedLogs = [
    ...cdpConsoleLogs,
    ...contentCaptures.consoleLogs.filter(
      (l) => !cdpLogKeys.has(`${l.level}|${l.message}|${Math.floor(l.timestamp / 500)}`),
    ),
  ].sort((a, b) => a.timestamp - b.timestamp);

  const cdpNetKeys = new Set(
    cdpNetworkEntries.map((e) => `${e.method}|${e.url}|${Math.floor(e.timestamp / 500)}`),
  );
  const mergedNet = [
    ...cdpNetworkEntries,
    ...contentCaptures.networkCaptures.filter(
      (e) => !cdpNetKeys.has(`${e.method}|${e.url}|${Math.floor(e.timestamp / 500)}`),
    ),
  ].sort((a, b) => a.timestamp - b.timestamp);

  pendingCaptureData = {
    consoleLogs: mergedLogs,
    networkCaptures: mergedNet,
    visitedUrls: [...visitedUrls],
  };
  visitedUrls = [];
  lastUrlByTab.clear();

  // Flip these BEFORE stopTimer()/hideFloatingToolbar(), not after: a poll tick
  // already in flight (kicked off by the interval a moment before stopTimer()
  // cancels it, or by the alarm) reads `isRecordingActive` when it resumes after
  // its own awaits — if that read still saw `true`, ensureToolbarOnActiveTab
  // would happily re-inject the toolbar right after (or mid-) hideFloatingToolbar
  // just hid it, which is exactly the "toolbar still there after stop" bug.
  isRecordingActive = false;
  isPaused = false;

  stopTimer();
  void chrome.alarms.clear(URL_POLL_ALARM);
  clearBadge();
  teardownDynamicTabAudio();
  await hideFloatingToolbar();
  // The persisted record was already removed at the top of this teardown, before
  // the first await, so no listener firing in between could restore it.

  const recordingDuration = elapsedSeconds;
  const recordingType = currentRecordingOptions?.type ?? 'screen';
  const recordingTitle = `Recording ${new Date().toLocaleString()}`;

  sendResponse({ success: true });

  if (cancel) {
    currentRecordingId = null;
    currentRecordingOptions = null;
    lastFocusedWindowId = null;
    elapsedSeconds = 0;
    // Offscreen will cleanup on its own; close it
    await closeOffscreenDocument();
    return;
  }

  const recordingId = currentRecordingId;
  const quality = currentRecordingOptions?.quality ?? '720p';
  const hasAudio =
    (currentRecordingOptions?.micEnabled || currentRecordingOptions?.systemAudio) ?? true;
  const hasWebcam = currentRecordingOptions?.webcamOverlay ?? false;

  currentRecordingId = null;
  currentRecordingOptions = null;
  currentRecordingTabId = null;
  lastFocusedWindowId = null;
  elapsedSeconds = 0;

  // Instruct offscreen to finalize blob into IndexedDB then upload
  try {
    await sendToOffscreen('OFFSCREEN_STOP_RECORDING', {
      recordingId,
      title: recordingTitle,
      type: recordingType,
      duration: recordingDuration,
      quality,
      hasAudio,
      hasWebcam,
    });
  } catch (err) {
    console.error('[Background] Stop recording error:', err);
    broadcastToAll({ type: 'RECORDING_ERROR', error: 'Failed to finalize recording' });
  }
  // Editor window is opened by handleOffscreenMessage when OFFSCREEN_RECORDING_READY fires
  // `stopInFlight` is released by handleStopRecording's own `finally` — held until
  // here on purpose, so a Stop arriving while the offscreen document is still
  // finalizing is answered as "already stopping" rather than starting a rival teardown.
}

// ─── PAUSE / RESUME ───────────────────────────────────────────────────────────

async function handlePauseRecording(): Promise<void> {
  // SW may have restarted — restore full in-memory state from storage.
  await ensureRecordingStateRestored();
  if (!isRecordingActive) return;
  if (isPaused) return;
  try {
    await sendToOffscreen('OFFSCREEN_PAUSE_RECORDING');
    isPaused = true;
    stopTimer();
    setBadge('||', '#f59e0b');
    broadcastToAll({ type: 'RECORDING_PAUSE_STATE', payload: { isPaused: true } });
  } catch (err) {
    console.error('[Background] Pause error:', err);
  }
}

async function handleResumeRecording(): Promise<void> {
  if (!isRecordingActive || !isPaused) return;
  try {
    await sendToOffscreen('OFFSCREEN_RESUME_RECORDING');
    isPaused = false;
    startTimer();
    setBadge('REC', '#ef4444');
    broadcastToAll({ type: 'RECORDING_PAUSE_STATE', payload: { isPaused: false } });
  } catch (err) {
    console.error('[Background] Resume error:', err);
  }
}

// ─── SCREENSHOT ───────────────────────────────────────────────────────────────

/** Convert an OffscreenCanvas blob → data URL without FileReader (SW-safe). */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

// captureVisibleTab only ever returns the tab's native physical pixels, so a small or
// low-zoom window otherwise produces a full-page screenshot well under Full HD width.
const MIN_FULL_PAGE_WIDTH = 1920;

/** Upscale a data URL so its width is never below `minWidth`, preserving aspect ratio. */
async function ensureMinWidth(dataUrl: string, minWidth = MIN_FULL_PAGE_WIDTH): Promise<string> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width >= minWidth) {
    bitmap.close();
    return dataUrl;
  }
  const scale = minWidth / bitmap.width;
  const canvas = new OffscreenCanvas(minWidth, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

/** Crop a data URL to a CSS-pixel rect accounting for devicePixelRatio. */
async function cropDataUrl(
  dataUrl: string,
  cssX: number,
  cssY: number,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): Promise<string> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const sx = Math.round(cssX * dpr);
  const sy = Math.round(cssY * dpr);
  const sw = Math.round(cssWidth * dpr);
  const sh = Math.round(cssHeight * dpr);
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

interface CaptureStrip {
  dataUrl: string;
  srcX: number; // physical px offset from left of the captured viewport image
  srcY: number; // physical px offset from top of the captured viewport image
  srcW: number; // physical px width of content to draw from this capture
  srcH: number; // physical px height of new content to draw from this capture
  destX: number; // physical px destination X on the final canvas
  destY: number; // physical px destination Y on the final canvas
}

/** Stitch non-overlapping strips into one full-page image. */
async function stitchCaptures(
  strips: CaptureStrip[],
  canvasWidth: number,
  canvasHeight: number,
): Promise<string> {
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d')!;
  for (const strip of strips) {
    try {
      const res = await fetch(strip.dataUrl);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(
        bitmap,
        strip.srcX,
        strip.srcY,
        strip.srcW,
        strip.srcH, // source rect
        strip.destX,
        strip.destY,
        strip.srcW,
        strip.srcH, // dest rect
      );
      bitmap.close();
    } catch (err) {
      warnFullPage('stitch strip failed (continuing):', String(err));
    }
  }
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

// Chrome throttles tabs.captureVisibleTab to ~2 calls/sec (MAX_CAPTURE_VISIBLE_TAB_
// CALLS_PER_SECOND). Capturing faster makes calls reject and strips go missing in the
// stitched image. Space captures out and retry on the quota error (like GoFullPage).
const CAPTURE_MIN_INTERVAL_MS = 550;
let lastCaptureTs = 0;

async function captureVisibleThrottled(windowId: number): Promise<string> {
  const sinceLast = Date.now() - lastCaptureTs;
  if (sinceLast < CAPTURE_MIN_INTERVAL_MS) {
    await new Promise<void>((r) => setTimeout(r, CAPTURE_MIN_INTERVAL_MS - sinceLast));
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      lastCaptureTs = Date.now();
      return dataUrl;
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      // Quota exceeded — wait a full interval and retry. Other errors are fatal.
      if (msg.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        await new Promise<void>((r) => setTimeout(r, CAPTURE_MIN_INTERVAL_MS));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('captureVisibleTab failed after retries');
}

/** Non-overlapping scroll positions covering `scrollHeight`, plus the final bottom. */
function buildScrollPositions(scrollHeight: number, clipHeight: number): number[] {
  const maxScrollY = Math.max(0, scrollHeight - clipHeight);
  const positions: number[] = [];
  for (let y = 0; y < maxScrollY; y += clipHeight) {
    positions.push(Math.round(y));
  }
  if (positions.length === 0 || positions[positions.length - 1] !== maxScrollY) {
    positions.push(maxScrollY);
  }
  return positions;
}

/**
 * Problems from the most recent captureFullPage() run — surfaced in the preview UI
 * so a genuinely incomplete capture is visible without anyone needing devtools open.
 *
 * Only things that actually degrade the RESULT belong here: dropped tiles, a capture
 * cropped short, a collapsed layout. Anything the code handled cleanly — which path
 * it took, which measurements it made, a fallback that worked — is `logFullPage`
 * instead, so a successful capture shows no warning banner at all.
 */
let fullPageWarnings: string[] = [];

function fmt(parts: unknown[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
}

/** A real defect in the produced image — shown to the user in the preview. */
function warnFullPage(...parts: unknown[]): void {
  const text = fmt(parts);
  fullPageWarnings.push(text);
  console.warn('[Background]', text);
}

/** Diagnostics for debugging only — console, never the preview banner. */
function logFullPage(...parts: unknown[]): void {
  console.log('[Background]', fmt(parts));
}

/**
 * Capture the whole page in ONE shot via the DevTools Protocol.
 *
 * This is the good path. `captureBeyondViewport` makes Chrome's compositor render
 * the entire document at once, so there is no scrolling, no tiling and no stitching
 * — which means none of the failure modes that plague the scroll-and-stitch path:
 * the page can't lazily re-render or reset its scroll position mid-capture, tiles
 * can't misalign, and no seams or gaps are possible.
 *
 * Returns null (never throws) when CDP isn't usable — most commonly because DevTools
 * is open on the tab, since Chrome allows only one debugger client per tab. The
 * caller falls back to the scroll-and-stitch path in that case.
 */
async function captureFullPageViaCDP(
  tabId: number,
  width: number,
  height: number,
  scale: number,
): Promise<string | null> {
  // Chrome refuses textures beyond ~16384px on a side; past that CDP returns an
  // empty/black image rather than an error, so bail out to tiling instead.
  const MAX_DIMENSION = 16000;
  if (width * scale > MAX_DIMENSION || height * scale > MAX_DIMENSION) {
    logFullPage(
      'Full-page: page too large for a single-shot capture',
      `(${Math.round(width * scale)}x${Math.round(height * scale)})`,
      '— falling back to tiled capture',
    );
    return null;
  }

  const target: chrome.debugger.Debuggee = { tabId };
  let weAttached = false;
  try {
    // Our own recording flow may already hold the debugger on this tab; reuse it
    // rather than fighting over the single-client limit.
    if (cdpTabId !== tabId) {
      await chrome.debugger.attach(target, '1.3');
      weAttached = true;
    }
    const result = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale },
    })) as { data?: string } | undefined;
    if (!result?.data) return null;
    return `data:image/png;base64,${result.data}`;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    logFullPage(
      'Full-page: single-shot capture unavailable —',
      msg.includes('Another debugger') || msg.includes('devtools')
        ? 'DevTools is open on this tab (close it for the best full-page result); using tiled capture'
        : `${msg}; using tiled capture`,
    );
    return null;
  } finally {
    if (weAttached) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Undo SCREENSHOT_EXPAND_SCROLLERS. Safe to call even if nothing was expanded. */
async function restoreScrollers(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_RESTORE_SCROLLERS',
    } as ExtensionMessage);
  } catch {
    /* ignore — page may have navigated away */
  }
}

async function captureFullPage(tabId: number, windowId: number): Promise<string> {
  fullPageWarnings = [];
  // ── 1. Get page dimensions ────────────────────────────────────────────────
  let dims: {
    scrollHeight: number; // content height of the scroll target (CSS px)
    viewportWidth: number; // FULL window width — canvas spans this so sidebars are kept
    viewportHeight: number; // FULL window height
    currentScrollX: number;
    currentScrollY: number;
    devicePixelRatio: number;
    // The scroll target's on-screen box (CSS px). This is the only region that changes
    // between frames, so frames after the first only redraw this column.
    clipX: number;
    clipY: number;
    clipWidth: number;
    clipHeight: number;
    scrollTargetDescription: string;
  };

  // Flatten inner scroll containers FIRST, so the page lays out as one long document
  // and the measurement below describes the whole thing. Capturing an inner scroller
  // tile-by-tile is what made SPA pages (Jira et al) re-render mid-capture and come
  // out truncated; flattened, they take the plain-long-document path that works.
  try {
    const flattened = (await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_EXPAND_SCROLLERS',
    } as ExtensionMessage)) as { expanded: number; scrollHeight: number; reverted?: boolean };
    if (flattened?.reverted) {
      warnFullPage(
        'Full-page: flattening collapsed the layout — reverted, capturing the inner',
        'scroll container instead',
      );
    } else if (flattened?.expanded) {
      logFullPage(
        'Full-page: flattened',
        flattened.expanded,
        'scroll container(s) → document height',
        flattened.scrollHeight,
      );
    }
  } catch {
    /* non-fatal — fall through to the scroll-the-inner-container path */
  }

  try {
    dims = (await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_GET_DIMENSIONS',
    } as ExtensionMessage)) as typeof dims;
  } catch (err) {
    warnFullPage('Full-page: failed to get dimensions, falling back:', String(err));
    await restoreScrollers(tabId);
    return ensureMinWidth(await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }));
  }
  // Always surfaced (not just on error) — this is the single most useful fact for
  // diagnosing a capture that confidently stops short with no other warning: exactly
  // which element was chosen as "the thing that scrolls," and how tall IT thinks the
  // page is at the very start, before any settling/pagination logic runs.
  logFullPage('Full-page: scroll target =', dims.scrollTargetDescription);

  const {
    viewportWidth,
    viewportHeight,
    currentScrollX,
    currentScrollY,
    devicePixelRatio: dpr,
    clipX,
    clipY,
    clipWidth,
    clipHeight,
  } = dims;
  let scrollHeight = dims.scrollHeight;

  // Content already fits the scroll target — nothing to scroll, simple capture.
  if (scrollHeight <= clipHeight + 2) {
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    await restoreScrollers(tabId);
    return ensureMinWidth(shot);
  }

  // ── 2. Pre-pass: sweep + settle, REPEATED until a full sweep adds no more height.
  // A single sweep only catches one loading cycle. Some feeds (e.g. Jira's Activity/
  // Comments) page in incrementally — each scroll-near-the-bottom triggers fetching
  // the NEXT batch, not the whole thread — so one settle only reveals the first page.
  // Re-sweeping the (now taller) page and re-settling, until a round adds nothing,
  // catches paginated content instead of silently stopping at whatever loaded first.
  const MAX_SETTLE_ROUNDS = 6;
  let settleRound = 0;
  for (; settleRound < MAX_SETTLE_ROUNDS; settleRound++) {
    for (const y of buildScrollPositions(scrollHeight, clipHeight)) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'SCREENSHOT_SCROLL_TO',
          payload: { x: 0, y },
        } as ExtensionMessage);
        await new Promise<void>((r) => setTimeout(r, 60));
      } catch {
        /* ignore */
      }
    }

    // Lazy-loaded content can keep growing for a while after the sweep above has
    // moved on. Wait until the page has gone quiet — no DOM mutations and no height
    // change — so this round measures the truly settled height for what loaded so
    // far. Skipping this is exactly what causes missing/misaligned content: positions
    // get built from a stale (shorter) height, and a tile whose capture instant lands
    // mid-reflow shows whatever happened to be there at that moment, not real content.
    let grew = false;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_WAIT_SETTLED',
        payload: { timeoutMs: 6000, quietMs: 500 },
      } as ExtensionMessage);
      // Re-flatten AFTER settling: whatever just finished loading may have re-created
      // a scroll container (re-clipping the page and collapsing the document back to
      // viewport height). Re-measure only once the page is flat again, so the height
      // we plan tiles from is the flattened one the capture will actually scroll.
      const reflattened = (await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_EXPAND_SCROLLERS',
      } as ExtensionMessage)) as { scrollHeight: number };
      if (reflattened.scrollHeight > scrollHeight) {
        scrollHeight = reflattened.scrollHeight;
        grew = true;
      }
    } catch {
      /* keep the measurement from this round */
    }
    if (!grew) break;
  }
  if (settleRound >= MAX_SETTLE_ROUNDS) {
    warnFullPage(
      'Full-page: content was still growing after',
      MAX_SETTLE_ROUNDS,
      'settle rounds — capture may still be missing content below',
      scrollHeight,
      'px (e.g. a very long/infinite comment thread)',
    );
  }

  const positions = buildScrollPositions(scrollHeight, clipHeight);
  logFullPage(
    'Full-page: settled scrollHeight =',
    scrollHeight,
    'clipHeight =',
    clipHeight,
    '→',
    positions.length,
    'tile(s) planned, after',
    settleRound + 1,
    'settle round(s)',
  );

  // ── 3. Preferred path: render the whole page in ONE shot via CDP ─────────
  // Nothing scrolls, so the page can't re-render or reset its scroll under us, and
  // there are no tiles to misalign. Only if this is unavailable (DevTools open on
  // the tab, or a page too large for one texture) do we fall back to tiling below.
  {
    const oneShot = await captureFullPageViaCDP(
      tabId,
      viewportWidth,
      clipY + scrollHeight,
      Math.min(2, Math.max(1, dpr || 1)),
    );
    if (oneShot) {
      logFullPage('Full-page: captured in a single shot (no scrolling needed)');
      await restoreScrollers(tabId);
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'SCREENSHOT_RESTORE_SCROLL',
          payload: { x: currentScrollX, y: currentScrollY },
        } as ExtensionMessage);
      } catch {
        /* ignore */
      }
      return ensureMinWidth(oneShot);
    }
  }

  // ── 4. Classify fixed/sticky overlays (header/sidebar/footer/composer) ───
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_PREPARE_CAPTURE',
    } as ExtensionMessage);
  } catch {
    /* non-fatal — capture continues without overlay handling */
  }

  // ── 4. Main capture pass: per frame → set overlay visibility → scroll → capture
  // Top overlays show only on the first frame, bottom overlays only on the last, so
  // each appears exactly once instead of repeating down every strip. Each position
  // gets one retry before being dropped — a message-port hiccup or a transient
  // captureVisibleTab error on any single tile (especially the LAST one) otherwise
  // leaves an undrawn gap with no way to recover it later.
  const rawCaptures: Array<{ dataUrl: string; actualScrollY: number; isFirst: boolean }> = [];
  let warnedLayoutBroken = false;

  for (let i = 0; i < positions.length; i++) {
    const targetY = positions[i]!;
    const phase = i === 0 ? 'first' : i === positions.length - 1 ? 'last' : 'middle';
    let lastErr: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const frameResult = (await chrome.tabs.sendMessage(tabId, {
          type: 'SCREENSHOT_SET_FRAME',
          payload: { phase },
        } as ExtensionMessage)) as { layoutBroken?: boolean };
        if (frameResult?.layoutBroken && !warnedLayoutBroken) {
          warnedLayoutBroken = true;
          warnFullPage(
            'Full-page: hiding a sticky/fixed element broke the page layout — left it',
            'visible instead (it may repeat down the capture)',
          );
        }

        const scrolled = (await chrome.tabs.sendMessage(tabId, {
          type: 'SCREENSHOT_SCROLL_TO',
          payload: { x: 0, y: targetY },
        } as ExtensionMessage)) as { actualScrollX: number; actualScrollY: number };

        // captureVisibleThrottled enforces the ~2/sec quota gap; the page renders
        // (and overlay visibility settles) during that wait. Add a small floor so the
        // compositor paints even on the first (un-throttled) capture.
        await new Promise<void>((r) => setTimeout(r, 120));

        const dataUrl = await captureVisibleThrottled(windowId);
        rawCaptures.push({ dataUrl, actualScrollY: scrolled.actualScrollY, isFirst: i === 0 });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          logFullPage('Full-page: retrying position', targetY, String(err));
          await new Promise<void>((r) => setTimeout(r, CAPTURE_MIN_INTERVAL_MS));
        }
      }
    }

    if (lastErr) {
      warnFullPage('Full-page: skipping position after retry', targetY, String(lastErr));
    }
  }

  // ── 5. Restore overlays and original scroll position ─────────────────────
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_RESTORE_CAPTURE',
    } as ExtensionMessage);
  } catch {
    /* ignore */
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_RESTORE_SCROLL',
      payload: { x: currentScrollX, y: currentScrollY },
    } as ExtensionMessage);
  } catch {
    /* ignore */
  }

  // Un-flatten before returning — the page must be left exactly as we found it.
  await restoreScrollers(tabId);

  if (rawCaptures.length === 0) {
    return ensureMinWidth(await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }));
  }

  // ── 6. Build strips ──────────────────────────────────────────────────────
  // Canvas spans the full window width. Height is sized to what was actually drawn
  // (prevEndY below), NOT the measured scrollHeight — if a tile still couldn't be
  // captured after the retry above, the canvas is cropped to the last contiguous row
  // instead of leaving the untouched remainder at the canvas's default black fill.
  //
  //  • First frame: drawn FULL-WIDTH from the top — this lays down everything outside
  //    the scroll column (sidebar, header) plus the first screen of content.
  //  • Later frames: only the scroll column [clipX, clipX+clipWidth) is redrawn, for
  //    the NEW content not already covered — so the sidebar/header are never repeated.
  // `window.devicePixelRatio` is not trustworthy here — it can disagree with the
  // ACTUAL pixel size of what captureVisibleTab returns (observed: a reported dpr
  // of 1 while the captured frame was really ~2x). Using the reported value to crop
  // each tile then only grabs a fraction of what the tile really contains, silently
  // dropping the rest — the exact cause of content going missing mid-page. Measure
  // the true horizontal/vertical scale from the first tile's actual bitmap instead.
  const firstDataUrl = rawCaptures[0]!.dataUrl;
  const firstBitmap = await createImageBitmap(await (await fetch(firstDataUrl)).blob());
  const dprX = firstBitmap.width / viewportWidth;
  const dprY = firstBitmap.height / viewportHeight;
  firstBitmap.close();
  if (Math.abs(dprX - dpr) > 0.05 || Math.abs(dprY - dpr) > 0.05) {
    logFullPage('Full-page: devicePixelRatio mismatch — reported', dpr, 'measured', { dprX, dprY });
  }

  const canvasW = Math.round(viewportWidth * dprX);
  const colSrcX = Math.round(clipX * dprX);
  const colW = Math.round(clipWidth * dprX);
  const strips: CaptureStrip[] = [];
  let prevEndY = 0; // CSS px, in scroll-target content coordinates

  for (const { dataUrl, actualScrollY, isFirst } of rawCaptures) {
    if (isFirst) {
      // Full viewport → top of canvas. Covers content rows [0, clipHeight).
      strips.push({
        dataUrl,
        srcX: 0,
        srcY: 0,
        srcW: canvasW,
        srcH: Math.round(viewportHeight * dprY),
        destX: 0,
        destY: 0,
      });
      prevEndY = clipHeight;
      continue;
    }

    const newStart = Math.max(prevEndY, actualScrollY);
    const newEnd = Math.min(actualScrollY + clipHeight, scrollHeight);
    if (newEnd <= newStart) continue;

    strips.push({
      dataUrl,
      srcX: colSrcX,
      srcY: Math.round((clipY + (newStart - actualScrollY)) * dprY),
      srcW: colW,
      srcH: Math.round((newEnd - newStart) * dprY),
      destX: colSrcX,
      destY: Math.round((clipY + newStart) * dprY),
    });
    prevEndY = newEnd;
  }

  if (prevEndY < scrollHeight - 1) {
    warnFullPage(
      'Full-page: only captured',
      prevEndY,
      'of',
      scrollHeight,
      '— cropping output instead of leaving a blank tail',
    );
  }
  const canvasH = Math.round((clipY + prevEndY) * dprY);

  // A full-height sidebar/margin sitting OUTSIDE the scroll column (a flex sibling of
  // the scroll target, not itself detected as an overlay — e.g. Jira's own left nav)
  // shows the SAME pixels in every tile, since it doesn't scroll. But tiles after the
  // first only redraw the scroll column, never that margin's X-range, so it would
  // otherwise sit at the canvas's default black fill for the rest of the page. Tile
  // frame 1's own margin columns downward to cover the remaining height instead.
  const frameH = Math.round(viewportHeight * dprY);
  if (canvasH > frameH) {
    const rightMarginX = colSrcX + colW;
    const rightMarginW = canvasW - rightMarginX;
    for (let y = frameH; y < canvasH; y += frameH) {
      const h = Math.min(frameH, canvasH - y);
      if (colSrcX > 0) {
        strips.push({
          dataUrl: firstDataUrl,
          srcX: 0,
          srcY: 0,
          srcW: colSrcX,
          srcH: h,
          destX: 0,
          destY: y,
        });
      }
      if (rightMarginW > 0) {
        strips.push({
          dataUrl: firstDataUrl,
          srcX: rightMarginX,
          srcY: 0,
          srcW: rightMarginW,
          srcH: h,
          destX: rightMarginX,
          destY: y,
        });
      }
    }
  }

  try {
    return await ensureMinWidth(await stitchCaptures(strips, canvasW, canvasH));
  } catch (err) {
    warnFullPage('Full-page: stitch failed, falling back:', String(err));
    return ensureMinWidth(await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }));
  }
}

/**
 * Ensure the content script is loaded in the tab before sending screenshot messages.
 * Uses the same try→inject→retry pattern as injectFloatingToolbar.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    // Ping via a lightweight synchronous handler
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_GET_DIMENSIONS',
    } as ExtensionMessage);
  } catch {
    // Content script not present (page was open before extension loaded/reloaded) — inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/index.js'],
      });
      await new Promise<void>((r) => setTimeout(r, 200));
    } catch (err) {
      console.warn('[Background] Content script injection failed:', err);
    }
  }
}

/** Download a screenshot data URL to disk — used when we can't show the in-page
 *  preview (e.g. restricted pages that can't host our content script). */
async function downloadScreenshot(dataUrl: string): Promise<void> {
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: `bestq-screenshot-${Date.now()}.png`,
      saveAs: false,
    });
  } catch (err) {
    console.error('[Background] Screenshot download fallback failed:', err);
  }
}

async function handleTakeScreenshot(
  screenshotType: string,
  tabId: number,
  windowId: number,
): Promise<void> {
  try {
    // Guarantee content script is alive before we try to talk to it.
    // This handles the common case where the page was open before the extension
    // was installed or reloaded — Chrome doesn't auto-re-inject content scripts.
    await ensureContentScript(tabId);

    let dataUrl: string;
    let warnings: string[] = [];

    if (screenshotType === 'visible') {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } else if (screenshotType === 'full-page') {
      dataUrl = await captureFullPage(tabId, windowId);
      // Surfaced in the preview UI directly — a partial/incomplete capture should be
      // visible to whoever took it, not just to someone who happens to have the
      // background service worker's devtools console open.
      warnings = [...fullPageWarnings];
    } else {
      // area — show the selector overlay; preview fires after SCREENSHOT_AREA_SELECTED
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_SHOW_SELECTOR',
      } as ExtensionMessage);
      return;
    }

    // Show the rich in-page preview when possible; on restricted pages the
    // content script isn't there, so download the screenshot instead.
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_SHOW_PREVIEW',
        payload: { dataUrl, warnings },
      } as ExtensionMessage);
    } catch {
      await downloadScreenshot(dataUrl);
    }
  } catch (err) {
    console.error('[Background] Screenshot error:', err);
  }
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage & { target?: string }, _sender, sendResponse) => {
    // Messages addressed to the offscreen document are relayed there
    if (message.target === 'offscreen') return false;

    // Messages from offscreen addressed to background
    if (message.target === 'background') {
      handleOffscreenMessage(message);
      return false;
    }

    // Popup / content-script messages
    switch (message.type) {
      case 'START_RECORDING': {
        const { options } = message.payload as { options: RecordingOptions };
        void handleStartRecording(options, sendResponse);
        return true;
      }

      case 'STOP_RECORDING': {
        const { cancel } = (message.payload as { cancel?: boolean }) ?? {};
        void handleStopRecording(sendResponse, cancel ?? false);
        return true;
      }

      case 'PAUSE_RECORDING': {
        void handlePauseRecording().then(() => sendResponse({ success: true }));
        return true;
      }

      case 'RESUME_RECORDING': {
        void handleResumeRecording().then(() => sendResponse({ success: true }));
        return true;
      }

      case 'SET_MIC_MUTED': {
        const { muted } = (message.payload as { muted?: boolean }) ?? {};
        void sendToOffscreen('OFFSCREEN_SET_MIC_MUTED', { muted: muted ?? false })
          .then(() => sendResponse({ success: true }))
          .catch((err: Error) => sendResponse({ error: err.message }));
        return true;
      }

      case 'TAKE_SCREENSHOT': {
        const {
          screenshotType = 'visible',
          tabId: payloadTabId,
          windowId: payloadWindowId,
        } = (message.payload as {
          screenshotType?: string;
          tabId?: number;
          windowId?: number;
        }) ?? {};

        void (async () => {
          try {
            // Prefer the tab/window resolved by the popup (most reliable).
            // If not present, fall back to lastFocusedWindow — do NOT use
            // currentWindow:true from a service worker (has no window context).
            let tabId = payloadTabId;
            let windowId = payloadWindowId;
            if (!tabId || !windowId) {
              const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              tabId = tab?.id;
              windowId = tab?.windowId;
            }
            if (tabId && windowId) {
              await handleTakeScreenshot(screenshotType, tabId, windowId);
            } else {
              console.error('[Background] Screenshot: no target tab found');
            }
          } catch (err) {
            console.error('[Background] TAKE_SCREENSHOT error:', err);
          }
        })();
        return false;
      }

      case 'SCREENSHOT_AREA_SELECTED': {
        const { x, y, width, height, devicePixelRatio } = message.payload as {
          x: number;
          y: number;
          width: number;
          height: number;
          devicePixelRatio: number;
        };
        const senderTabId = _sender.tab?.id;
        const senderWindowId = _sender.tab?.windowId;
        if (!senderTabId || !senderWindowId) return false;
        void (async () => {
          try {
            const raw = await chrome.tabs.captureVisibleTab(senderWindowId, { format: 'png' });
            const cropped = await cropDataUrl(raw, x, y, width, height, devicePixelRatio);
            await ensureContentScript(senderTabId);
            await chrome.tabs.sendMessage(senderTabId, {
              type: 'SCREENSHOT_SHOW_PREVIEW',
              payload: { dataUrl: cropped },
            } as ExtensionMessage);
          } catch (err) {
            console.error('[Background] Area screenshot error:', err);
          }
        })();
        return false;
      }

      // ── Screen monitoring ────────────────────────────────────────────────
      // The popup only ever sends intents; the session itself lives in the
      // manager, so closing the popup cannot end somebody's working day (§32).
      case 'MONITORING_START': {
        const { intervalSeconds, project } = (message.payload ?? {}) as {
          intervalSeconds?: MonitoringInterval;
          project?: string;
        };
        void startMonitoringSession({
          intervalSeconds: intervalSeconds ?? 60,
          project,
        }).then((state) => sendResponse(state));
        return true;
      }

      case 'MONITORING_STOP': {
        void stopMonitoringSession().then((state) => sendResponse(state));
        return true;
      }

      case 'MONITORING_PAUSE': {
        void pauseMonitoringSession().then((state) => sendResponse(state));
        return true;
      }

      case 'MONITORING_RESUME': {
        void resumeMonitoringSession().then((state) => sendResponse(state));
        return true;
      }

      case 'MONITORING_RECONNECT_CAPTURE': {
        // The stream died and only the user can authorise a replacement. The
        // session itself continues untouched, so nothing already recorded is
        // affected by re-granting.
        void reconnectMonitoringCapture().then((state) => sendResponse(state));
        return true;
      }

      case 'MONITORING_GET_STATE': {
        // Read-through: a popup opening against a freshly-woken worker must get
        // the live session's real state, not an empty in-memory default.
        void loadMonitoringState().then((state) => sendResponse(state));
        return true;
      }

      case 'GET_STATE': {
        void (async () => {
          await ensureRecordingStateRestored();
          // Tell a content script whether it should self-mount the toolbar on
          // load: a tab recording shows it only on the recorded tab, while a
          // screen/window share shows it on every page. Non-tab senders (the
          // popup) get `true` — they don't mount the toolbar anyway.
          const senderTabId = _sender.tab?.id;
          // `stopInFlight` counts as not-recording here even though the flags are
          // still set: a content script asking this question during a teardown must
          // not self-mount a toolbar onto a page the stop has already swept.
          const live = isRecordingActive && !stopInFlight;
          const showToolbar =
            live &&
            (currentRecordingOptions?.type === 'screen' ||
              senderTabId == null ||
              currentRecordingTabId === senderTabId);
          sendResponse({
            isRecording: live,
            isPaused,
            elapsedSeconds,
            recordingId: currentRecordingId,
            showToolbar,
          });
        })();
        return true;
      }

      case 'ENSURE_TOOLBAR': {
        // Re-surface the floating toolbar on the current tab. Used when the user
        // clicks the extension while recording but the toolbar was lost (page
        // navigation, content-script eviction, etc.). Reports back whether the
        // toolbar could be injected — the popup falls back to in-popup controls
        // when the active page is restricted (chrome://, Web Store, …).
        void (async () => {
          try {
            await ensureRecordingStateRestored();
            if (!isRecordingActive || stopInFlight || !currentRecordingId) {
              sendResponse({ injected: false });
              return;
            }
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id || isRestrictedUrl(tab.url)) {
              sendResponse({ injected: false, restricted: true });
              return;
            }
            const injected = await injectFloatingToolbar(tab.id);
            sendResponse({ injected });
          } catch (err) {
            console.error('[Background] ENSURE_TOOLBAR error:', err);
            sendResponse({ injected: false });
          }
        })();
        return true;
      }

      case 'TOKEN_REFRESHED': {
        const { expiresAt } = message.payload as { expiresAt: number };
        void authManager.onTokenRefreshed(expiresAt);
        return false;
      }

      case 'AUTH_STATE_CHANGED': {
        const { isAuthenticated } = message.payload as { isAuthenticated: boolean };
        if (!isAuthenticated) void authManager.onLogout();
        return false;
      }

      case 'START_GOOGLE_LOGIN': {
        // Open ReportPortal's login page, then auto-advance to Google and capture
        // the bearer token the UI receives (see startGoogleLogin).
        void startGoogleLogin();
        sendResponse({ success: true });
        return false;
      }

      case 'OPEN_POPUP': {
        chrome.action.openPopup().catch(() => {
          // openPopup requires user gesture in some Chrome versions; open popup page as fallback
          void chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html') });
        });
        sendResponse({ success: true });
        return false;
      }

      default:
        return false;
    }
  },
);

// ─── Drafts index ───────────────────────────────────────────────────────────
// Registers a finished recording in the Drafts list as soon as it's ready —
// independent of whether the editor window ever successfully opens/loads.
// Only chrome.storage.local is touched here (no OPFS/IDB access from a service
// worker); blobs evicted past the 5-slot cap are queued for a DOM-context page
// (editor or popup) to actually delete.

async function registerDraft(entry: DraftRecording): Promise<void> {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.DRAFTS_INDEX,
    STORAGE_KEYS.PENDING_BLOB_CLEANUP,
  ]);
  const existing = (result[STORAGE_KEYS.DRAFTS_INDEX] as DraftRecording[] | undefined) ?? [];
  const deduped = existing.filter((d) => d.recordingId !== entry.recordingId);
  const next = [entry, ...deduped];

  const kept = next.slice(0, MAX_DRAFTS);
  const evicted = next.slice(MAX_DRAFTS);

  const update: Record<string, unknown> = { [STORAGE_KEYS.DRAFTS_INDEX]: kept };
  if (evicted.length > 0) {
    const cleanup = (result[STORAGE_KEYS.PENDING_BLOB_CLEANUP] as string[] | undefined) ?? [];
    const evictedIds = evicted.map((d) => d.recordingId);
    update[STORAGE_KEYS.PENDING_BLOB_CLEANUP] = [...new Set([...cleanup, ...evictedIds])];
  }
  await chrome.storage.local.set(update);
}

// ─── Offscreen → Background Message Handler ───────────────────────────────────

function handleOffscreenMessage(message: ExtensionMessage & { target?: string }): void {
  switch (message.type as string) {
    case 'OFFSCREEN_MONITORING_SNAPSHOT_STORED':
    case 'OFFSCREEN_MONITORING_CAPTURE_ENDED': {
      void handleMonitoringOffscreenMessage(message.type as string, message.payload);
      return;
    }

    case 'OFFSCREEN_CAPTURE_ENDED': {
      // The captured surface went away on its own — the user clicked the browser's
      // own "Stop sharing" bar, closed the shared window, or the display went away.
      // The recording is over whether or not anyone pressed our Stop, so run the
      // normal teardown: it saves what was captured and clears the toolbar, instead
      // of leaving the controls counting up over a stream that is already dead.
      console.log('[Background] Captured surface ended — stopping recording');
      void handleStopRecording(() => {
        /* nobody is waiting on a response for this one */
      });
      return;
    }

    case 'OFFSCREEN_RECORDING_READY': {
      const {
        thumbnailDataUrl,
        duration,
        blobSize,
        shareUrl,
        recordingId: readyRecordingId,
        title: readyTitle,
        recordingType: readyRecordingType,
      } = message.payload as {
        thumbnailDataUrl: string | null;
        duration: number;
        blobSize: number;
        shareUrl: string | null;
        recordingId?: string;
        title?: string;
        recordingType?: string;
      };

      const editorRecordingId = readyRecordingId ?? 'unknown';

      // Use an async IIFE so we can await the storage write before opening the editor window.
      void (async () => {
        if (!shareUrl) {
          // Persist capture data + thumbnail, then open editor
          const capture = pendingCaptureData ?? {
            consoleLogs: [],
            networkCaptures: [],
            visitedUrls: [],
          };
          pendingCaptureData = null;
          await chrome.storage.local.set({
            [STORAGE_KEYS.EDITOR_DATA]: {
              recordingId: editorRecordingId,
              thumbnailDataUrl: thumbnailDataUrl ?? null,
              duration,
              blobSize,
              title: readyTitle ?? `Recording ${new Date().toLocaleString()}`,
              recordingType: readyRecordingType ?? currentRecordingOptions?.type ?? 'screen',
              consoleLogs: capture.consoleLogs,
              networkCaptures: capture.networkCaptures,
              visitedUrls: capture.visitedUrls,
            },
          });
          await registerDraft({
            recordingId: editorRecordingId,
            title: readyTitle ?? `Recording ${new Date().toLocaleString()}`,
            thumbnailDataUrl: thumbnailDataUrl ?? null,
            duration,
            blobSize,
            recordingType: readyRecordingType ?? currentRecordingOptions?.type ?? 'screen',
            createdAt: Date.now(),
            status: 'draft',
          });
          await chrome.windows.create({
            url: chrome.runtime.getURL(`src/editor/index.html?recordingId=${editorRecordingId}`),
            type: 'popup',
            width: 1400,
            height: 900,
            focused: true,
          });
          // Upload is now editor-triggered — offscreen has no more work to do
          void closeOffscreenDocument();
        }
      })();
      break;
    }

    case 'OFFSCREEN_UPLOAD_PROGRESS': {
      broadcastToAll({ type: 'UPLOAD_PROGRESS', payload: message.payload });
      break;
    }

    case 'OFFSCREEN_UPLOAD_COMPLETE': {
      const { shareUrl, recordingId } = message.payload as {
        shareUrl: string;
        recordingId?: string;
      };
      broadcastToAll({ type: 'UPLOAD_COMPLETE', payload: { shareUrl, recordingId } });

      // Persist for popup that may not be open when upload finishes
      void chrome.storage.local.set({
        [STORAGE_KEYS.PENDING_SHARE]: { shareUrl, recordingId: recordingId ?? null },
      });

      // Close offscreen document now that upload is complete
      void closeOffscreenDocument();
      break;
    }

    case 'OFFSCREEN_ERROR': {
      const { error } = message.payload as { error: string };
      broadcastToAll({ type: 'RECORDING_ERROR', error });
      void closeOffscreenDocument();
      break;
    }
  }
}

// ─── Keyboard Commands ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  switch (command) {
    case 'start-recording': {
      if (!isRecordingActive) {
        chrome.action.openPopup().catch(() => {
          void handleStartRecording(
            {
              type: 'screen',
              quality: '720p',
              micEnabled: true,
              webcamOverlay: false,
              systemAudio: false,
            },
            () => {},
          );
        });
      }
      break;
    }
    case 'stop-recording': {
      // No `isRecordingActive` guard: this flag is in-memory, so it reads false in
      // any freshly-woken worker — which a long recording produces constantly. The
      // shortcut was therefore silently dead exactly when it is most needed (the
      // user reaching for it because the toolbar is misbehaving). handleStopRecording
      // restores state from storage itself and handles the genuinely-not-recording
      // case, so let it decide.
      void handleStopRecording(() => {}, false);
      break;
    }
    case 'take-screenshot': {
      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && tab?.windowId) {
          await handleTakeScreenshot('visible', tab.id, tab.windowId);
        }
      })();
      break;
    }
  }
});

// ─── Navigation — Toolbar Re-injection ───────────────────────────────────────
// These fire whenever the user navigates (full reload or SPA history change)
// within a tab that has an active recording. The toolbar is re-injected
// automatically so it always stays visible during recording.

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return; // top-level frame only — ignore iframes
  void reinjectToolbarIntoTab(tabId);
  void recordVisitedUrl(tabId, url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  void reinjectToolbarIntoTab(tabId);
  void recordVisitedUrl(tabId, url);
});

// Keep the toolbar visible when the user switches to an already-loaded tab or
// focuses another browser window mid-recording. Neither fires a navigation
// event, so without these the toolbar would be missing on that page — and a
// tab switch with no navigation (e.g. an already-open tab) would otherwise
// never get logged as a visited URL either.
// ─── Monitoring activity listeners ────────────────────────────────────────────
//
// ONE listener per event, funnelling into `noteActivePage`. The previous code
// added a second `tabs.onActivated`, a third `tabs.onUpdated` and a second
// `windows.onFocusChanged` alongside the recording ones, so a single tab switch
// ran the activity path several times and each pass could open and close an
// interval — producing duplicate rows for one action.
//
// `noteActivePage` is itself idempotent (it compares a stable identity and
// returns early when nothing meaningful changed), which is what makes several
// events describing the same navigation collapse into one interval.

/** Resolve the tab an event refers to, tolerating it having closed. */
const monitoringTab = (tabId: number): Promise<chrome.tabs.Tab | undefined> =>
  chrome.tabs.get(tabId).catch(() => undefined);

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // Recording's own bookkeeping (unchanged behaviour).
  lastFocusedWindowId = windowId;
  void ensureToolbarOnActiveTab(tabId);
  void recordVisitedUrl(tabId);
  // Monitoring.
  void monitoringTab(tabId).then((tab) => noteActivePage(tab));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    // Recording's visited-URL tracking, deliberately not filtered on `active`.
    void recordVisitedUrl(tabId, tab.url);
  }
  // Monitoring cares only about the tab the user is actually looking at, and
  // only once it has settled — a URL change fires repeatedly during a load.
  if (!tab.active) return;
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
    void noteActivePage(tab);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Every browser window lost focus: the user is in another application.
    // Without the native agent this is the only signal that the browser is no
    // longer what they are using, so the page interval must close here or its
    // time would be credited to a page nobody is looking at.
    void noteBrowserBlurred();
    return;
  }
  lastFocusedWindowId = windowId;
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab?.id) {
        await ensureToolbarOnActiveTab(tab.id);
        void recordVisitedUrl(tab.id);
        void noteActivePage(tab);
      }
    } catch {
      /* window may have closed — ignore */
    }
  })();
});

/*
 * Single-page-app route changes.
 *
 * `onHistoryStateUpdated` is the only signal for a Jira board → Jira issue
 * navigation: no document loads, so `onUpdated` never reports `complete` and
 * tab activation never fires. Without this, an afternoon of moving between
 * pages inside one SPA collapsed into a single undifferentiated interval.
 *
 * `onCommitted` covers a real document navigation early, so the interval
 * boundary lands at the navigation rather than at the end of the page load.
 */
const monitoringNavigation = ({ tabId, frameId }: { tabId: number; frameId: number }): void => {
  if (frameId !== 0) return; // top-level frame only — iframes are not navigations
  void monitoringTab(tabId).then((tab) => {
    if (tab?.active) void noteActivePage(tab);
  });
};

chrome.webNavigation.onCommitted.addListener(monitoringNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(monitoringNavigation);

/*
 * The recording-side handlers for these three events were merged into the
 * consolidated listeners above rather than registered separately.
 *
 * Every behaviour they had is preserved there verbatim:
 *  - `onActivated` still seeds `lastFocusedWindowId` as an implicit focus
 *    signal (defence in depth alongside onFocusChanged, which is documented as
 *    occasionally unfired — crbug 391471) and still calls
 *    ensureToolbarOnActiveTab + recordVisitedUrl.
 *  - `onFocusChanged` still re-derives the focused window's active tab.
 *  - `onUpdated` still records a visited URL on `complete` for ANY tab, not
 *    only the active one: cross-window navigation during a screen recording is
 *    not reliably reflected in the active-tab bookkeeping, and recordVisitedUrl
 *    has its own per-tab dedup so an unrelated background reload cannot spam
 *    the list.
 *
 * They live in one place now because registering two listeners for the same
 * event made a single tab switch run the activity path twice, which produced
 * duplicate activity intervals for one user action.
 */

// ─── Startup / Install ────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  await authManager.initialize();
  // Alarms and idle listeners do not survive a worker teardown; a session that
  // is still open server-side needs both re-armed or it will silently expire.
  await restoreMonitoringSession();
  void triggerOffscreenQueueProcessing();
  // A browser crash/restart mid-recording would otherwise leave this repeating
  // alarm firing forever with nothing to restore into — restoreStateFromStorage
  // below re-arms it if there genuinely is a recording still in progress.
  await restoreStateFromStorage();
  if (!isRecordingActive) void chrome.alarms.clear(URL_POLL_ALARM);
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await authManager.initialize();
  void triggerOffscreenQueueProcessing();

  if (reason === 'install') {
    chrome.tabs.create({ url: RP_HOST });
  }
});

async function triggerOffscreenQueueProcessing(): Promise<void> {
  try {
    // Check if there's anything in the queue before creating offscreen
    const result = await chrome.storage.local.get([STORAGE_KEYS.OFFLINE_QUEUE]);
    const queue = result[STORAGE_KEYS.OFFLINE_QUEUE] as unknown[] | undefined;
    if (!queue || queue.length === 0) return;

    await ensureOffscreenDocument();
    await sendToOffscreen('OFFSCREEN_PROCESS_QUEUE');
  } catch (err) {
    console.error('[Background] Offline queue processing error:', err);
  }
}

// ─── Login Detection — Process Offline Queue ──────────────────────────────────
// Fires when tokens are written to storage (both email/password login via popup
// and Google OAuth login via the tab interceptor below).

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const tokenChange = changes[STORAGE_KEYS.AUTH_TOKENS];
  // Only trigger when tokens go from absent → present (fresh login, not refresh)
  if (tokenChange?.newValue && !tokenChange.oldValue) {
    void triggerOffscreenQueueProcessing();
  }
});

// ─── Google OAuth — Bearer Token Capture ──────────────────────────────────────
// ReportPortal's "Login with Google" is a session/cookie based flow:
//   /uat/oauth/login/google → Google consent → /uat/sso/login/google?code=...
//   → the server establishes a session; the UI then loads at /ui/ and calls the
//     API with `Authorization: Bearer <jwt>`.
// The JWT is never present in a tab URL, so we capture it off the UI's own API
// requests via chrome.webRequest (scoped to the tab we opened), then sign the
// extension in with it — same result as pasting an access token.

const GOOGLE_AUTH_TAB_KEY = 'google_auth_tab_id';
const GOOGLE_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

let googleAuthTabId: number | null = null;
let googleAuthCaptured = false;
let googleAuthAdvanced = false;
let googleAuthTimeout: ReturnType<typeof setTimeout> | null = null;

// Re-hydrate the capture target if the service worker restarted mid-flow.
void chrome.storage.session.get(GOOGLE_AUTH_TAB_KEY).then((r) => {
  const id = r[GOOGLE_AUTH_TAB_KEY] as number | undefined;
  if (typeof id === 'number' && googleAuthTabId === null) googleAuthTabId = id;
});

function armGoogleLoginCapture(tabId: number): void {
  googleAuthTabId = tabId;
  googleAuthCaptured = false;
  googleAuthAdvanced = false;
  void chrome.storage.session.set({ [GOOGLE_AUTH_TAB_KEY]: tabId });
  if (googleAuthTimeout) clearTimeout(googleAuthTimeout);
  googleAuthTimeout = setTimeout(() => void disarmGoogleLoginCapture(), GOOGLE_AUTH_TIMEOUT_MS);
}

async function disarmGoogleLoginCapture(): Promise<void> {
  googleAuthTabId = null;
  googleAuthCaptured = false;
  googleAuthAdvanced = false;
  if (googleAuthTimeout) {
    clearTimeout(googleAuthTimeout);
    googleAuthTimeout = null;
  }
  await chrome.storage.session.remove(GOOGLE_AUTH_TAB_KEY);
}

/**
 * "Continue with Google" with no visible ReportPortal page:
 *  1. Open ReportPortal's login page in a HIDDEN (background) tab. Loading it
 *     for real primes the frontend session/CSRF that the OAuth endpoint needs
 *     (a cold hit returns "Bad credentials").
 *  2. When it finishes loading, auto-advance that tab to /uat/oauth/login/google
 *     (see the webNavigation.onCompleted listener below).
 *  3. When the tab reaches Google, bring it to the front so the user sees the
 *     account chooser (see the webNavigation.onBeforeNavigate listener below).
 *  4. The bearer token that comes back is grabbed by the webRequest listener
 *     above, which signs the extension in and closes the tab.
 */
async function startGoogleLogin(): Promise<void> {
  console.log('[GoogleLogin] starting — opening hidden ReportPortal tab');
  const tab = await chrome.tabs.create({ url: RP_LOGIN_URL, active: false });
  console.log('[GoogleLogin] tab created:', tab.id);
  if (tab.id != null) armGoogleLoginCapture(tab.id);
}

// Step 2: once the ReportPortal page has loaded in our tab, advance to Google.
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0 || details.tabId !== googleAuthTabId) return;
  if (googleAuthAdvanced || googleAuthCaptured) return;
  if (!details.url.startsWith(`${RP_HOST}/ui`)) return;

  googleAuthAdvanced = true;
  console.log('[GoogleLogin] /ui loaded — navigating to Google OAuth');
  chrome.scripting
    .executeScript({
      target: { tabId: details.tabId },
      // Same-origin navigation from the loaded /ui/ page — reproduces exactly
      // the request ReportPortal's own "Login with Google" button makes.
      func: () => {
        window.location.href = '/uat/oauth/login/google';
      },
    })
    .then(() => console.log('[GoogleLogin] advance injected'))
    .catch((e) => {
      console.warn('[GoogleLogin] executeScript failed, falling back to tabs.update', e);
      chrome.tabs
        .update(details.tabId, { url: `${RP_HOST}/uat/oauth/login/google` })
        .catch(() => {});
    });
});

// Step 3: when the tab reaches Google's sign-in, surface it to the user.
// Use both events — onBeforeNavigate catches client-initiated navigations,
// onCommitted catches server redirects (the /uat/oauth/login/google → Google
// redirect commits without a fresh onBeforeNavigate).
function focusIfGoogle(details: { frameId: number; tabId: number; url: string }): void {
  if (details.frameId !== 0 || details.tabId !== googleAuthTabId) return;
  if (!details.url.startsWith('https://accounts.google.com')) return;

  console.log('[GoogleLogin] reached Google — focusing tab');
  chrome.tabs.update(details.tabId, { active: true }).catch(() => {});
  void chrome.tabs
    .get(details.tabId)
    .then((t) => {
      if (t.windowId != null) return chrome.windows.update(t.windowId, { focused: true });
    })
    .catch(() => {});
}
chrome.webNavigation.onBeforeNavigate.addListener(focusIfGoogle);
chrome.webNavigation.onCommitted.addListener(focusIfGoogle);

/** Decode a claim from a JWT payload; returns null if not a decodable JWT. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Fetch the user's profile photo (raw image bytes) and return it as a data URL,
 * or null if there's no photo / the request fails. Uses the SW-safe blobToDataUrl
 * (FileReader isn't reliable in service workers).
 */
async function fetchUserPhotoDataUrl(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/data/photo?loadThumbnail=true&at=${Date.now()}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'image/*' },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

/**
 * Validate the captured token by fetching the current user, then store auth
 * state exactly like a token login (no refresh token — expiry triggers logout).
 */
async function completeGoogleLogin(accessToken: string, sourceTabId: number): Promise<void> {
  if (googleAuthCaptured) return;
  googleAuthCaptured = true; // set before any await so concurrent requests bail
  console.log('[GoogleLogin] captured bearer token — validating & signing in');

  try {
    const res = await fetch(`${API_BASE_URL}/users`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`/users returned ${res.status}`);
    const rpUser = (await res.json()) as {
      id: number;
      userId: string;
      email: string;
      fullName: string;
      photoId: string | null;
      userRole: string;
      active: boolean;
      assignedProjects?: Record<string, unknown>;
    };

    const user = {
      id: String(rpUser.id),
      login: rpUser.userId,
      email: rpUser.email ?? '',
      name: rpUser.fullName ?? rpUser.userId,
      avatar: await fetchUserPhotoDataUrl(accessToken),
      role: rpUser.userRole,
      isActive: rpUser.active ?? true,
      assignedProjects: rpUser.assignedProjects,
    };

    // Re-apply any locally-edited name/avatar for this user so signing in again
    // via Google doesn't revert their edits to stale server values.
    try {
      const ovr = await chrome.storage.local.get([STORAGE_KEYS.AUTH_PROFILE_OVERRIDES]);
      const all =
        (ovr[STORAGE_KEYS.AUTH_PROFILE_OVERRIDES] as Record<
          string,
          { name?: string; avatar?: string }
        >) ?? {};
      const override = all[user.login];
      if (override) Object.assign(user, override);
    } catch {
      /* no overrides — use server values */
    }

    const claims = decodeJwtPayload(accessToken);
    const exp = typeof claims?.exp === 'number' ? claims.exp * 1000 : null;
    const tokens = {
      accessToken,
      refreshToken: '',
      expiresAt: exp ?? Date.now() + 12 * 60 * 60 * 1000,
    };

    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_TOKENS]: tokens,
      [STORAGE_KEYS.AUTH_USER]: user,
      [STORAGE_KEYS.AUTH_SESSION_ID]: typeof claims?.jti === 'string' ? claims.jti : '',
    });

    console.log('[GoogleLogin] signed in as', user.login, `(${user.email})`);
    broadcastToAll({ type: 'OAUTH_LOGIN_COMPLETE', payload: { user, tokens } });

    // Return the user to their browsing context.
    try {
      await chrome.tabs.remove(sourceTabId);
    } catch {
      // Tab already closed — ignore.
    }
    await disarmGoogleLoginCapture();
  } catch (err) {
    console.error('[Background] Google login token capture failed:', err);
    googleAuthCaptured = false; // allow a retry within the armed window
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (googleAuthTabId === null || details.tabId !== googleAuthTabId || googleAuthCaptured) return;
    const auth = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'authorization');
    const value = (auth?.value ?? '').trim();
    console.log(
      '[GoogleLogin] api request on tab:',
      details.url,
      '| auth:',
      value ? value.slice(0, 12) : '(none)',
    );
    const match = /^bearer\s+(eyJ[\w-]+\.[\w-]+\.[\w-]+)$/i.exec(value);
    if (!match) return;
    void completeGoogleLogin(match[1], details.tabId);
  },
  { urls: [`${RP_HOST}/api/*`] },
  ['requestHeaders', 'extraHeaders'],
);

// If the user closes the OAuth tab before it completes, stop capturing.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === googleAuthTabId) void disarmGoogleLoginCapture();
});

// ─── Tab Cleanup ──────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!isRecordingActive) return;
  if (currentRecordingTabId !== tabId) return;
  const result = await chrome.storage.local.get([STORAGE_KEYS.RECORDING_STATE]);
  const state = result[STORAGE_KEYS.RECORDING_STATE] as { options?: RecordingOptions } | undefined;
  if (state?.options?.type === 'tab') {
    void handleStopRecording(() => {}, false);
  }
});

// ─── SW Activation Restore ────────────────────────────────────────────────────
// Runs on every SW activation (first load and after suspension wake-up).
// Restores in-memory recording state + CDP captures from persistent storage
// so an active recording survives SW termination transparently.

void restoreStateFromStorage();
