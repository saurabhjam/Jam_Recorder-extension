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

// ─── State Restore (after SW termination) ────────────────────────────────────

async function restoreStateFromStorage(): Promise<void> {
  if (isRecordingActive) return;
  const stored = await chrome.storage.local.get([STORAGE_KEYS.RECORDING_STATE]);
  const state = stored[STORAGE_KEYS.RECORDING_STATE] as
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
}

// ─── CDP Capture State ────────────────────────────────────────────────────────

let cdpTabId: number | null = null;
let cdpConsoleLogs: CaptureConsoleLog[] = [];
// requestId → partial entry (finalised on loadingFinished/loadingFailed)
const cdpNetworkMap = new Map<string, Partial<CaptureNetworkEntry> & { startedAt: number }>();
let cdpNetworkEntries: CaptureNetworkEntry[] = [];
// Holds merged capture data between stopRecording and OFFSCREEN_RECORDING_READY
let pendingCaptureData: CaptureData | null = null;

async function attachDebugger(tabId: number): Promise<void> {
  cdpTabId = tabId;
  cdpConsoleLogs = [];
  cdpNetworkMap.clear();
  cdpNetworkEntries = [];
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}),
      chrome.debugger.sendCommand({ tabId }, 'Log.enable', {}),
    ]);
  } catch (err) {
    console.warn('[Background] CDP attach failed (non-fatal):', err);
    cdpTabId = null; // fall back to content-script capture only
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

    // Attach Chrome Debugger to capture network + console (best-effort)
    if (currentRecordingTabId) void attachDebugger(currentRecordingTabId);

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

  // CDP is the authoritative source. Fall back to content-script only if CDP captured nothing.
  pendingCaptureData = {
    consoleLogs:
      cdpConsoleLogs.length > 0
        ? [...cdpConsoleLogs].sort((a, b) => a.timestamp - b.timestamp)
        : [...contentCaptures.consoleLogs].sort((a, b) => a.timestamp - b.timestamp),
    networkCaptures:
      cdpNetworkEntries.length > 0
        ? [...cdpNetworkEntries].sort((a, b) => a.timestamp - b.timestamp)
        : [...contentCaptures.networkCaptures].sort((a, b) => a.timestamp - b.timestamp),
  };

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

async function handleTakeScreenshot(sendResponse: (r: unknown) => void): Promise<void> {
  let streamId: string;
  try {
    streamId = 'native-display-media';
  } catch (err) {
    sendResponse({ error: err instanceof Error ? err.message : 'Screenshot cancelled' });
    return;
  }

  try {
    await ensureOffscreenDocument();
    await sendToOffscreen('OFFSCREEN_TAKE_SCREENSHOT', { streamId });
    sendResponse({ success: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Screenshot failed';
    sendResponse({ error });
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

      case 'TAKE_SCREENSHOT': {
        void handleTakeScreenshot(sendResponse);
        return true;
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
            width: 960,
            height: 680,
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
      void handleTakeScreenshot(() => {});
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
    chrome.tabs.create({ url: 'http://localhost:3001' });
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

const API_BASE_FOR_OAUTH = 'http://localhost:3000/api';

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;

  let url: URL;
  try {
    url = new URL(changeInfo.url);
  } catch {
    return;
  }

  // Match http://localhost:3001/auth/callback?accessToken=...
  const isOAuthCallback =
    url.hostname === 'localhost' &&
    (url.port === '3001' || url.port === '3000') &&
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
  fetch(`${API_BASE_FOR_OAUTH}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
    .then((res) => {
      if (!res.ok) throw new Error(`/auth/me returned ${res.status}`);
      return res.json() as Promise<{ data: unknown }>;
    })
    .then(async (body) => {
      const user = body.data;
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
