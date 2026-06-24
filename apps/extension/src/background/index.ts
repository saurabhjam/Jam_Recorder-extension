/**
 * SnapTrace — Background Service Worker (Manifest V3)
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
  CaptureData,
} from '@/types';
import { STORAGE_KEYS } from '@/types';
import { generateId } from '@/utils';

// ─── Offscreen Management ─────────────────────────────────────────────────────

const OFFSCREEN_URL = 'src/offscreen/index.html';

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Screen and webcam recording requires media device access',
    });
  }
}

async function closeOffscreenDocument(): Promise<void> {
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

// ─── Recording State ──────────────────────────────────────────────────────────

let currentRecordingId: string | null = null;
let currentRecordingOptions: RecordingOptions | null = null;
let currentRecordingTabId: number | null = null;
let elapsedSeconds = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let isRecordingActive = false;
let isPaused = false;

// ─── CDP Session Storage Key ──────────────────────────────────────────────────
// Declared early — used in both restoreStateFromStorage (below) and the CDP
// capture state section. Session storage survives SW suspension within a browser
// session, so captures are preserved even if the SW is killed mid-recording.
const CDP_SESSION_KEY = 'st_cdp_captures';

// ─── State Restore (after SW termination) ────────────────────────────────────

async function restoreStateFromStorage(): Promise<void> {
  if (isRecordingActive) return;
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

  // Restore CDP captures that were flushed to session storage before SW suspended
  const captures = sessionStored[CDP_SESSION_KEY] as
    | { consoleLogs: CaptureConsoleLog[]; networkEntries: CaptureNetworkEntry[] }
    | undefined;
  if (captures) {
    cdpConsoleLogs = captures.consoleLogs ?? [];
    cdpNetworkEntries = captures.networkEntries ?? [];
    console.log(
      `[CDP] Restored ${cdpConsoleLogs.length} logs, ${cdpNetworkEntries.length} network entries from session storage after SW restart`,
    );
  }

  // Re-attach CDP so captures continue after SW suspension
  if (currentRecordingTabId) {
    console.log(`[Background] SW reactivated — re-attaching CDP to tab ${currentRecordingTabId}`);
    void reattachDebugger(currentRecordingTabId);
  }
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
    void chrome.storage.session
      .set({
        [CDP_SESSION_KEY]: {
          consoleLogs: cdpConsoleLogs.slice(-1000),
          networkEntries: cdpNetworkEntries.slice(-1000),
        },
      })
      .catch(() => {});
  }, 2000);
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
      const req = p['request'] as { url: string; method: string } | undefined;
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
        source: 'cdp',
      });
      break;
    }

    case 'Network.responseReceived': {
      const res = p['response'] as
        | { status: number; statusText: string; mimeType: string }
        | undefined;
      const entry = cdpNetworkMap.get(p['requestId'] as string);
      if (entry && res) {
        entry.status = res.status;
        entry.statusText = res.statusText;
        entry.mimeType = res.mimeType;
      }
      break;
    }

    case 'Network.loadingFinished': {
      const entry = cdpNetworkMap.get(p['requestId'] as string);
      if (entry) {
        entry.size = (p['encodedDataLength'] as number | undefined) ?? 0;
        entry.duration = Date.now() - entry.startedAt;
        cdpNetworkEntries.push(entry as CaptureNetworkEntry);
        cdpNetworkMap.delete(p['requestId'] as string);
        scheduleCaptureFlush();
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

function startTimer(): void {
  elapsedSeconds = 0;
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    broadcastToAll({ type: 'UPDATE_TIMER', payload: { duration: elapsedSeconds } });
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function broadcastToAll(message: ExtensionMessage): void {
  // Popup / extension pages
  chrome.runtime.sendMessage(message).catch(() => {});

  // Active tab content scripts
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
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

  // ── XHR ──────────────────────────────────────────────────────────────────
  const _OrigXHR = w.XMLHttpRequest as typeof XMLHttpRequest;
  w.XMLHttpRequest = function (): XMLHttpRequest {
    const xhr = new _OrigXHR();
    const meta = { url: '', method: 'GET', start: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _origOpen = (xhr.open as any).bind(xhr) as (...a: unknown[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (xhr as any).open = (...args: unknown[]): void => {
      meta.method = String(args[0] ?? 'GET').toUpperCase();
      meta.url = String(args[1] ?? '');
      _origOpen(...args);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _origSend = (xhr.send as any).bind(xhr) as (...a: unknown[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (xhr as any).send = (...args: unknown[]): void => {
      meta.start = Date.now();
      xhr.addEventListener('loadend', () => {
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
    const t = Date.now();
    return _origFetch(input, init).then(
      (r: Response): Response => {
        void r
          .clone()
          .arrayBuffer()
          .catch((): ArrayBuffer => new ArrayBuffer(0))
          .then((buf: ArrayBuffer): void => {
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

async function injectFloatingToolbar(targetTabId?: number): Promise<void> {
  let tabId = targetTabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (!tabId) return;

  const showMsg = {
    type: 'SHOW_TOOLBAR' as const,
    payload: { recordingId: currentRecordingId },
  } satisfies ExtensionMessage;

  // Try messaging first (content script already running)
  try {
    await chrome.tabs.sendMessage(tabId, showMsg);
    return;
  } catch {
    // Content script not ready — inject it programmatically then retry
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/index.js'],
    });
    await new Promise<void>((r) => setTimeout(r, 150));
    await chrome.tabs.sendMessage(tabId, showMsg);
  } catch (err) {
    console.error('[Background] Could not inject toolbar into tab', tabId, err);
  }
}

// Re-inject toolbar after navigation (page reload, SPA route change, etc.)
async function reinjectToolbarIntoTab(tabId: number): Promise<void> {
  if (!isRecordingActive) {
    await restoreStateFromStorage();
    if (!isRecordingActive) return;
  }
  // For tab/webcam: only the recording tab gets the toolbar.
  // For screen: any tab the user navigates in gets it (screen capture is global).
  if (
    currentRecordingOptions?.type !== 'screen' &&
    currentRecordingTabId !== null &&
    currentRecordingTabId !== tabId
  )
    return;
  // CDP auto-detaches on cross-origin navigation — always re-attach so captures
  // continue uninterrupted after navigations. Accumulated entries are preserved.
  void reattachDebugger(tabId);
  await injectFloatingToolbar(tabId);
  void injectMainWorldCaptureScript(tabId);
}

async function hideFloatingToolbar(): Promise<void> {
  const tabId = currentRecordingTabId;
  try {
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, { type: 'HIDE_TOOLBAR' } satisfies ExtensionMessage);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, { type: 'HIDE_TOOLBAR' } satisfies ExtensionMessage);
      }
    }
  } catch {
    /* ignore — tab may already be closed */
  }
}

// ─── desktopCapture Stream ID ─────────────────────────────────────────────────

// function chooseDesktopMedia(sources: string[]): Promise<string> {
//   return new Promise((resolve, reject) => {
//     // @ts-expect-error — desktopCapture types
//     chrome.desktopCapture.chooseDesktopMedia(sources, (streamId: string) => {
//       if (chrome.runtime.lastError || !streamId) {
//         reject(new Error(chrome.runtime.lastError?.message ?? 'User cancelled or capture failed'));
//         return;
//       }
//       resolve(streamId);
//     });
//   });
// }

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

// ─── START RECORDING ──────────────────────────────────────────────────────────

async function handleStartRecording(
  options: RecordingOptions,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  if (isRecordingActive) {
    sendResponse({ error: 'A recording is already in progress' });
    return;
  }

  currentRecordingId = generateId();
  currentRecordingOptions = options;

  let streamId: string | undefined;
  // For desktop recording we additionally tab-capture the active tab's audio so
  // meeting/system voice is recorded even when the user shares the whole screen
  // — macOS can't capture system-loopback audio for screen/window shares.
  let tabAudioStreamId: string | undefined;

  try {
    if (options.type === 'screen') {
      streamId = 'native-display-media';
      if (options.systemAudio) {
        try {
          const tabId =
            options.tabId ??
            (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          if (tabId) tabAudioStreamId = await getTabStreamId(tabId);
        } catch {
          // Active tab not capturable (chrome://, no tab, etc.) — fall back to
          // whatever system audio getDisplayMedia provides.
        }
      }
    } else if (options.type === 'tab') {
      const tabId =
        options.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
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

    await sendToOffscreen('OFFSCREEN_START_RECORDING', {
      options,
      streamId,
      tabAudioStreamId,
      recordingId: currentRecordingId,
    });

    isRecordingActive = true;
    isPaused = false;

    // Determine the active tab so we can attach CDP and show the toolbar
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentRecordingTabId = activeTab?.id ?? null;

    setBadge('REC', '#ef4444');
    await injectFloatingToolbar();
    startTimer();

    // Attach Chrome Debugger (CDP) + inject main-world capture script for
    // full coverage: CDP for all traffic, scripting API for CSP-strict pages.
    if (currentRecordingTabId) {
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
    await closeOffscreenDocument();

    broadcastToAll({ type: 'RECORDING_ERROR', error });
    sendResponse({ error });
  }
}

// ─── STOP RECORDING ───────────────────────────────────────────────────────────

async function handleStopRecording(
  sendResponse: (r: unknown) => void,
  cancel = false,
): Promise<void> {
  // SW may have restarted — restore in-memory state from storage
  if (!isRecordingActive) {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.RECORDING_STATE]);
    const state = stored[STORAGE_KEYS.RECORDING_STATE] as
      | { isRecording: boolean; recordingId: string; options: RecordingOptions }
      | undefined;
    if (!state?.isRecording) {
      sendResponse({ error: 'No active recording' });
      return;
    }
    isRecordingActive = true;
    currentRecordingId = state.recordingId;
    currentRecordingOptions = state.options;
  }

  // ── Flush content-script captures before hiding toolbar ──────────────────
  const flushTabId = currentRecordingTabId ?? cdpTabId;
  let contentCaptures: CaptureData = { consoleLogs: [], networkCaptures: [] };
  if (flushTabId) {
    try {
      const flushed = (await chrome.tabs.sendMessage(flushTabId, { type: 'CAPTURE_FLUSH' })) as
        | { consoleLogs: CaptureConsoleLog[]; networkCaptures: CaptureNetworkEntry[] }
        | undefined;
      if (flushed) {
        contentCaptures = {
          consoleLogs: flushed.consoleLogs,
          networkCaptures: flushed.networkCaptures,
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

  pendingCaptureData = { consoleLogs: mergedLogs, networkCaptures: mergedNet };

  stopTimer();
  clearBadge();
  await hideFloatingToolbar();
  await chrome.storage.local.remove([STORAGE_KEYS.RECORDING_STATE]);

  const recordingDuration = elapsedSeconds;
  const recordingType = currentRecordingOptions?.type ?? 'screen';
  const recordingTitle = `Recording ${new Date().toLocaleString()}`;

  isRecordingActive = false;
  isPaused = false;

  sendResponse({ success: true });

  if (cancel) {
    currentRecordingId = null;
    currentRecordingOptions = null;
    elapsedSeconds = 0;
    // Offscreen will cleanup on its own; close it
    await closeOffscreenDocument();
    return;
  }

  const recordingId = currentRecordingId;
  const quality = currentRecordingOptions?.quality ?? 'high';
  const hasAudio =
    (currentRecordingOptions?.micEnabled || currentRecordingOptions?.systemAudio) ?? true;
  const hasWebcam = currentRecordingOptions?.webcamOverlay ?? false;

  currentRecordingId = null;
  currentRecordingOptions = null;
  currentRecordingTabId = null;
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
}

// ─── PAUSE / RESUME ───────────────────────────────────────────────────────────

async function handlePauseRecording(): Promise<void> {
  // SW may have restarted — restore in-memory state from storage
  if (!isRecordingActive) {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.RECORDING_STATE]);
    const state = stored[STORAGE_KEYS.RECORDING_STATE] as
      | { isRecording: boolean; recordingId: string; options: RecordingOptions }
      | undefined;
    if (!state?.isRecording) return;
    isRecordingActive = true;
    currentRecordingId = state.recordingId;
    currentRecordingOptions = state.options;
  }
  if (isPaused) return;
  try {
    await sendToOffscreen('OFFSCREEN_PAUSE_RECORDING');
    isPaused = true;
    stopTimer();
    setBadge('||', '#f59e0b');
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
  srcY: number; // physical px offset from top of the captured viewport image
  srcH: number; // physical px height of new content to draw from this capture
  destY: number; // physical px destination Y on the final canvas
  canvasW: number; // physical px canvas width (same for all strips)
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
        0,
        strip.srcY,
        strip.canvasW,
        strip.srcH, // source rect
        0,
        strip.destY,
        strip.canvasW,
        strip.srcH, // dest rect
      );
      bitmap.close();
    } catch (err) {
      console.warn('[Background] stitch strip failed (continuing):', err);
    }
  }
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

async function captureFullPage(tabId: number, windowId: number): Promise<string> {
  // ── 1. Get page dimensions ────────────────────────────────────────────────
  let dims: {
    scrollWidth: number;
    scrollHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    currentScrollX: number;
    currentScrollY: number;
    devicePixelRatio: number;
  };

  try {
    dims = (await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_GET_DIMENSIONS',
    } as ExtensionMessage)) as typeof dims;
  } catch (err) {
    console.error('[Background] Full-page: failed to get dimensions, falling back:', err);
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }

  const {
    scrollHeight,
    viewportWidth,
    viewportHeight,
    currentScrollX,
    currentScrollY,
    devicePixelRatio: dpr,
  } = dims;

  // Page fits in viewport — simple capture
  if (scrollHeight <= viewportHeight + 2) {
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }

  const maxScrollY = Math.max(0, scrollHeight - viewportHeight);

  // ── 2. Build non-overlapping scroll positions (no duplicates) ────────────
  // Each position is exactly viewportHeight apart, plus the final bottom position.
  const positions: number[] = [];
  for (let y = 0; y < maxScrollY; y += viewportHeight) {
    positions.push(Math.round(y));
  }
  if (positions[positions.length - 1] !== maxScrollY) {
    positions.push(maxScrollY);
  }

  // ── 3. Pre-pass: scroll through all positions quickly to trigger lazy loading
  for (const y of positions) {
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

  // ── 4. Hide fixed/sticky elements so they don't pollute every strip ──────
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_PREPARE_CAPTURE',
    } as ExtensionMessage);
  } catch {
    /* non-fatal — capture continues without hiding */
  }

  // ── 5. Main capture pass: scroll → wait → capture ────────────────────────
  const rawCaptures: Array<{ dataUrl: string; actualScrollY: number }> = [];

  for (const targetY of positions) {
    try {
      const scrolled = (await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_SCROLL_TO',
        payload: { x: 0, y: targetY },
      } as ExtensionMessage)) as { actualScrollX: number; actualScrollY: number };

      // Wait for compositor + any remaining lazy-load renders
      await new Promise<void>((r) => setTimeout(r, 180));

      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      rawCaptures.push({ dataUrl, actualScrollY: scrolled.actualScrollY });
    } catch (err) {
      console.warn('[Background] Full-page: skipping position', targetY, err);
    }
  }

  // ── 6. Restore fixed elements and original scroll position ───────────────
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

  if (rawCaptures.length === 0) {
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }

  // ── 7. Build strips — each draws only the NEW content not in previous strips
  //
  // For capture at actualScrollY S showing page rows [S, S+VH):
  //   newStart = max(prevEndY, S)          — skip already-drawn overlap
  //   newEnd   = min(S + VH, scrollHeight) — don't draw past page bottom
  //   srcY     = (newStart - S) * dpr      — offset in the captured bitmap
  //   srcH     = (newEnd - newStart) * dpr
  //   destY    = newStart * dpr
  //
  const canvasW = Math.round(viewportWidth * dpr);
  const canvasH = Math.round(scrollHeight * dpr);
  const strips: CaptureStrip[] = [];
  let prevEndY = 0; // CSS px

  for (const { dataUrl, actualScrollY } of rawCaptures) {
    const newStart = Math.max(prevEndY, actualScrollY);
    const newEnd = Math.min(actualScrollY + viewportHeight, scrollHeight);
    if (newEnd <= newStart) continue;

    strips.push({
      dataUrl,
      srcY: Math.round((newStart - actualScrollY) * dpr),
      srcH: Math.round((newEnd - newStart) * dpr),
      destY: Math.round(newStart * dpr),
      canvasW,
    });
    prevEndY = newEnd;
  }

  try {
    return await stitchCaptures(strips, canvasW, canvasH);
  } catch (err) {
    console.error('[Background] Full-page: stitch failed, falling back:', err);
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
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

    if (screenshotType === 'visible') {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } else if (screenshotType === 'full-page') {
      dataUrl = await captureFullPage(tabId, windowId);
    } else {
      // area — show the selector overlay; preview fires after SCREENSHOT_AREA_SELECTED
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_SHOW_SELECTOR',
      } as ExtensionMessage);
      return;
    }

    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_SHOW_PREVIEW',
      payload: { dataUrl },
    } as ExtensionMessage);
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

      case 'GET_STATE': {
        void (async () => {
          if (!isRecordingActive) await restoreStateFromStorage();
          sendResponse({
            isRecording: isRecordingActive,
            isPaused,
            elapsedSeconds,
            recordingId: currentRecordingId,
          });
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

// ─── Offscreen → Background Message Handler ───────────────────────────────────

function handleOffscreenMessage(message: ExtensionMessage & { target?: string }): void {
  switch (message.type as string) {
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
          const capture = pendingCaptureData ?? { consoleLogs: [], networkCaptures: [] };
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
            },
          });
          await chrome.windows.create({
            url: chrome.runtime.getURL(`src/editor/index.html?recordingId=${editorRecordingId}`),
            type: 'popup',
            width: 1200,
            height: 800,
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
              quality: 'high',
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
      if (isRecordingActive) void handleStopRecording(() => {}, false);
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

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return; // top-level frame only — ignore iframes
  void reinjectToolbarIntoTab(tabId);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  void reinjectToolbarIntoTab(tabId);
});

// ─── Startup / Install ────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  await authManager.initialize();
  void triggerOffscreenQueueProcessing();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await authManager.initialize();
  void triggerOffscreenQueueProcessing();

  if (reason === 'install') {
    chrome.tabs.create({ url: 'https://reportsv1.best-quality.in' });
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

// ─── Google OAuth Tab Interceptor ─────────────────────────────────────────────
// Watches for the OAuth callback URL, extracts tokens, fetches the user profile,
// stores everything in extension storage, and closes the OAuth tab.

const API_BASE_FOR_OAUTH = (() => {
  try {
    return (
      (import.meta as { env?: Record<string, string> }).env?.['VITE_API_BASE_URL'] ??
      'https://reportsv1.best-quality.in/api'
    );
  } catch {
    return 'https://reportsv1.best-quality.in/api';
  }
})();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;

  let url: URL;
  try {
    url = new URL(changeInfo.url);
  } catch {
    return;
  }

  // Match /auth/callback?accessToken=... on the real frontend
  const isOAuthCallback =
    (url.hostname === 'reportsv1.best-quality.in' ||
      (url.hostname === 'localhost' && (url.port === '3001' || url.port === '3000'))) &&
    url.pathname === '/auth/callback';

  if (!isOAuthCallback) return;

  const accessToken = url.searchParams.get('accessToken');
  const refreshToken = url.searchParams.get('refreshToken');
  const expiresAt = url.searchParams.get('expiresAt');

  if (!accessToken || !refreshToken) return;

  // Close the OAuth tab immediately so the user returns to their browsing context
  chrome.tabs.remove(tabId);

  const tokens = {
    accessToken,
    refreshToken,
    expiresAt: expiresAt ? Number(expiresAt) : Date.now() + 30 * 60 * 1000,
  };

  // Fetch user profile then store everything
  fetch(`${API_BASE_FOR_OAUTH}/users`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
    .then((res) => {
      if (!res.ok) throw new Error(`/users returned ${res.status}`);
      return res.json() as Promise<{
        id: number;
        userId: string;
        email: string;
        fullName: string;
        photoId: string | null;
        userRole: string;
        active: boolean;
      }>;
    })
    .then(async (rpUser) => {
      const user = {
        id: String(rpUser.id),
        login: rpUser.userId,
        email: rpUser.email ?? '',
        name: rpUser.fullName ?? rpUser.userId,
        avatar: rpUser.photoId ?? null,
        role: rpUser.userRole,
        isActive: rpUser.active ?? true,
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.AUTH_TOKENS]: tokens,
        [STORAGE_KEYS.AUTH_USER]: user,
      });
      await authManager.scheduleRefreshAlarm(tokens.expiresAt);
      broadcastToAll({ type: 'OAUTH_LOGIN_COMPLETE', payload: { user, tokens } });
    })
    .catch((err) => {
      console.error('[Background] OAuth user fetch failed:', err);
    });
});

// ─── Tab Cleanup ──────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async () => {
  if (!isRecordingActive) return;
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
