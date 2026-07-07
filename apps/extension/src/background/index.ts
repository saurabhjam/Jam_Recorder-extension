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
  CaptureData,
} from '@/types';
import { STORAGE_KEYS } from '@/types';
import { generateId, isRestrictedUrl } from '@/utils';
import { RP_HOST, API_BASE_URL, RP_LOGIN_URL } from '@/config';

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

async function injectFloatingToolbar(targetTabId?: number): Promise<boolean> {
  let tabId = targetTabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (!tabId) return false;

  const showMsg = {
    type: 'SHOW_TOOLBAR' as const,
    payload: { recordingId: currentRecordingId },
  } satisfies ExtensionMessage;

  // Try messaging first (content script already running)
  try {
    await chrome.tabs.sendMessage(tabId, showMsg);
    return true;
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
    return true;
  } catch (err) {
    console.error('[Background] Could not inject toolbar into tab', tabId, err);
    return false;
  }
}

// Re-inject toolbar after navigation (page reload, SPA route change, etc.)
async function reinjectToolbarIntoTab(tabId: number): Promise<void> {
  if (!isRecordingActive) {
    await restoreStateFromStorage();
    if (!isRecordingActive) return;
  }

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
async function ensureToolbarOnActiveTab(tabId: number): Promise<void> {
  if (!isRecordingActive) {
    await restoreStateFromStorage();
    if (!isRecordingActive) return;
  }
  // Tab recording → controls live on the recorded tab only; don't surface them on
  // other tabs (those aren't being recorded). Screen/window share → the toolbar
  // follows the user across tabs and windows.
  if (currentRecordingOptions?.type !== 'screen' && currentRecordingTabId !== tabId) return;
  await injectFloatingToolbar(tabId);
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

    // For screen/window shares that produced no direct audio (macOS), start
    // capturing tab audio across the selected scope — the picked window, or the
    // whole browser for entire-screen — and keep following tabs as they play.
    if (options.type === 'screen' && options.systemAudio && startResp?.needsTabAudio) {
      await setupDynamicTabAudio(startResp.displaySurface, activeTab?.windowId ?? null);
    }

    setBadge('REC', '#ef4444');
    await injectFloatingToolbar();
    startTimer();

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
  teardownDynamicTabAudio();
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
  const quality = currentRecordingOptions?.quality ?? '720p';
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
      console.warn('[Background] stitch strip failed (continuing):', err);
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

async function captureFullPage(tabId: number, windowId: number): Promise<string> {
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
    clipX,
    clipY,
    clipWidth,
    clipHeight,
  } = dims;

  // Content already fits the scroll target — nothing to scroll, simple capture.
  if (scrollHeight <= clipHeight + 2) {
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }

  const maxScrollY = Math.max(0, scrollHeight - clipHeight);

  // ── 2. Build non-overlapping scroll positions (no duplicates) ────────────
  // Each step advances by the scroll target's visible height, plus the final bottom.
  const positions: number[] = [];
  for (let y = 0; y < maxScrollY; y += clipHeight) {
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

  // ── 4. Classify fixed/sticky overlays (header/sidebar/footer/composer) ───
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SCREENSHOT_PREPARE_CAPTURE',
    } as ExtensionMessage);
  } catch {
    /* non-fatal — capture continues without overlay handling */
  }

  // ── 5. Main capture pass: per frame → set overlay visibility → scroll → capture
  // Top overlays show only on the first frame, bottom overlays only on the last, so
  // each appears exactly once instead of repeating down every strip.
  const rawCaptures: Array<{ dataUrl: string; actualScrollY: number; isFirst: boolean }> = [];

  for (let i = 0; i < positions.length; i++) {
    const targetY = positions[i]!;
    const phase = i === 0 ? 'first' : i === positions.length - 1 ? 'last' : 'middle';
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_SET_FRAME',
        payload: { phase },
      } as ExtensionMessage);

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
    } catch (err) {
      console.warn('[Background] Full-page: skipping position', targetY, err);
    }
  }

  // ── 6. Restore overlays and original scroll position ─────────────────────
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

  // ── 7. Build strips ──────────────────────────────────────────────────────
  // Canvas spans the full window width and the content's full height. Content row Y
  // (in the scroll target) maps to canvas Y = clipY + Y.
  //
  //  • First frame: drawn FULL-WIDTH from the top — this lays down everything outside
  //    the scroll column (sidebar, header) plus the first screen of content.
  //  • Later frames: only the scroll column [clipX, clipX+clipWidth) is redrawn, for
  //    the NEW content not already covered — so the sidebar/header are never repeated.
  const canvasW = Math.round(viewportWidth * dpr);
  const canvasH = Math.round((clipY + scrollHeight) * dpr);
  const colSrcX = Math.round(clipX * dpr);
  const colW = Math.round(clipWidth * dpr);
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
        srcH: Math.round(viewportHeight * dpr),
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
      srcY: Math.round((clipY + (newStart - actualScrollY)) * dpr),
      srcW: colW,
      srcH: Math.round((newEnd - newStart) * dpr),
      destX: colSrcX,
      destY: Math.round((clipY + newStart) * dpr),
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

    // Show the rich in-page preview when possible; on restricted pages the
    // content script isn't there, so download the screenshot instead.
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SCREENSHOT_SHOW_PREVIEW',
        payload: { dataUrl },
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

      case 'GET_STATE': {
        void (async () => {
          if (!isRecordingActive) await restoreStateFromStorage();
          // Tell a content script whether it should self-mount the toolbar on
          // load: a tab recording shows it only on the recorded tab, while a
          // screen/window share shows it on every page. Non-tab senders (the
          // popup) get `true` — they don't mount the toolbar anyway.
          const senderTabId = _sender.tab?.id;
          const showToolbar =
            isRecordingActive &&
            (currentRecordingOptions?.type === 'screen' ||
              senderTabId == null ||
              currentRecordingTabId === senderTabId);
          sendResponse({
            isRecording: isRecordingActive,
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
            if (!isRecordingActive) await restoreStateFromStorage();
            if (!isRecordingActive || !currentRecordingId) {
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

// Keep the toolbar visible when the user switches to an already-loaded tab or
// focuses another browser window mid-recording. Neither fires a navigation
// event, so without these the toolbar would be missing on that page.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ensureToolbarOnActiveTab(tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab?.id) await ensureToolbarOnActiveTab(tab.id);
    } catch {
      /* window may have closed — ignore */
    }
  })();
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
