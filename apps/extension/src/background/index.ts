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
import type { ExtensionMessage, RecordingOptions } from '@/types';
import { STORAGE_KEYS, AUTH_REFRESH_ALARM } from '@/types';
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
let elapsedSeconds = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let isRecordingActive = false;
let isPaused = false;

interface PreviewState {
  thumbnailDataUrl: string | null;
  duration: number;
  blobSize: number;
  shareUrl: string | null;
}
let pendingPreview: PreviewState | null = null;

async function pushPreviewToTab(payload: {
  thumbnailDataUrl: string | null;
  duration: number;
  blobSize: number;
  shareUrl: string | null;
  uploadProgress: number;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs
        .sendMessage(tab.id, {
          type: 'SHOW_PREVIEW',
          payload,
        })
        .catch(() => {
          // Content script not injected yet — inject then retry
          chrome.scripting
            .executeScript({ target: { tabId: tab.id! }, files: ['src/content/index.js'] })
            .then(() => chrome.tabs.sendMessage(tab.id!, { type: 'SHOW_PREVIEW', payload }))
            .catch(() => {});
        });
    }
  } catch {
    /* ignore */
  }
}

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

async function injectFloatingToolbar(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Try messaging first (content script already loaded)
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_TOOLBAR',
      payload: { recordingId: currentRecordingId },
    } satisfies ExtensionMessage);
    return;
  } catch {
    /* fall through — inject script then retry */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/index.js'],
    });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_TOOLBAR',
      payload: { recordingId: currentRecordingId },
    } satisfies ExtensionMessage);
  } catch (err) {
    console.warn('[Background] Could not inject floating toolbar:', err);
  }
}

async function hideFloatingToolbar(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'HIDE_TOOLBAR' } satisfies ExtensionMessage);
    }
  } catch {
    /* ignore */
  }
}

// ─── desktopCapture Stream ID ─────────────────────────────────────────────────

function chooseDesktopMedia(sources: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // @ts-expect-error — desktopCapture types
    chrome.desktopCapture.chooseDesktopMedia(sources, (streamId: string) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'User cancelled or capture failed'));
        return;
      }
      resolve(streamId);
    });
  });
}

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
      streamId = await chooseDesktopMedia(['screen', 'window']);
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

    setBadge('REC', '#ef4444');
    await injectFloatingToolbar();
    startTimer();

    await chrome.storage.local.set({
      [STORAGE_KEYS.RECORDING_STATE]: {
        isRecording: true,
        recordingId: currentRecordingId,
        startedAt: Date.now(),
        options,
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
  if (!isRecordingActive) {
    sendResponse({ error: 'No active recording' });
    return;
  }

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

  // Instruct offscreen to finalize + upload
  try {
    await sendToOffscreen('OFFSCREEN_STOP_RECORDING', {
      title: recordingTitle,
      type: recordingType,
      duration: recordingDuration,
      quality: currentRecordingOptions?.quality ?? 'high',
      hasAudio:
        (currentRecordingOptions?.micEnabled || currentRecordingOptions?.systemAudio) ?? true,
      hasWebcam: currentRecordingOptions?.webcamOverlay ?? false,
    });
  } catch (err) {
    console.error('[Background] Stop recording error:', err);
    broadcastToAll({ type: 'RECORDING_ERROR', error: 'Failed to finalize recording' });
  }

  currentRecordingId = null;
  currentRecordingOptions = null;
  elapsedSeconds = 0;
}

// ─── PAUSE / RESUME ───────────────────────────────────────────────────────────

async function handlePauseRecording(): Promise<void> {
  if (!isRecordingActive || isPaused) return;
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
    streamId = await chooseDesktopMedia(['screen', 'window']);
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

// ─── Utility ─────────────────────────────────────────────────────────────────

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(',');
  const mime = header?.match(/:(.*?);/)?.[1] ?? 'image/png';
  const binary = atob(data ?? '');
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
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
        sendResponse({
          isRecording: isRecordingActive,
          isPaused,
          elapsedSeconds,
          recordingId: currentRecordingId,
        });
        return false;
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
      const { thumbnailDataUrl, duration, blobSize, shareUrl } = message.payload as {
        thumbnailDataUrl: string | null;
        duration: number;
        blobSize: number;
        shareUrl: string | null;
      };
      // Preserve the thumbnail from the first call when the second call provides the shareUrl
      pendingPreview = {
        thumbnailDataUrl: thumbnailDataUrl ?? pendingPreview?.thumbnailDataUrl ?? null,
        duration,
        blobSize,
        shareUrl,
      };
      void pushPreviewToTab({
        thumbnailDataUrl: pendingPreview.thumbnailDataUrl,
        duration,
        blobSize,
        shareUrl,
        uploadProgress: 0,
      });
      break;
    }

    case 'OFFSCREEN_UPLOAD_PROGRESS': {
      broadcastToAll({ type: 'UPLOAD_PROGRESS', payload: message.payload });
      const prog = message.payload as { percentComplete: number };
      void pushPreviewToTab({
        thumbnailDataUrl: pendingPreview?.thumbnailDataUrl ?? null,
        duration: pendingPreview?.duration ?? 0,
        blobSize: pendingPreview?.blobSize ?? 0,
        shareUrl: pendingPreview?.shareUrl ?? null,
        uploadProgress: prog.percentComplete ?? 0,
      });
      break;
    }

    case 'OFFSCREEN_UPLOAD_COMPLETE': {
      const { shareUrl, recordingId } = message.payload as {
        shareUrl: string;
        recordingId?: string;
      };
      broadcastToAll({ type: 'UPLOAD_COMPLETE', payload: { shareUrl, recordingId } });

      // Push the share URL to the content script preview panel
      void pushPreviewToTab({
        thumbnailDataUrl: pendingPreview?.thumbnailDataUrl ?? null,
        duration: pendingPreview?.duration ?? 0,
        blobSize: pendingPreview?.blobSize ?? 0,
        shareUrl,
        uploadProgress: 100,
      });
      pendingPreview = null;

      // Persist for popup that may not be open when upload finishes
      void chrome.storage.local.set({
        [STORAGE_KEYS.PENDING_SHARE]: { shareUrl, recordingId: recordingId ?? null },
      });

      // Show browser notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Recording Ready!',
        message: 'Your recording has been uploaded. Click to view and share.',
        buttons: [{ title: 'View & Share' }],
        priority: 2,
      });

      // Close offscreen document now that upload is complete
      void closeOffscreenDocument();
      break;
    }

    case 'OFFSCREEN_ERROR': {
      const { error } = message.payload as { error: string };
      broadcastToAll({ type: 'RECORDING_ERROR', error });
      void pushPreviewToTab({
        thumbnailDataUrl: pendingPreview?.thumbnailDataUrl ?? null,
        duration: pendingPreview?.duration ?? 0,
        blobSize: pendingPreview?.blobSize ?? 0,
        shareUrl: pendingPreview?.shareUrl ?? null,
        uploadProgress: -1,
        errorMessage: error, // pass specific error so panel shows it
      });
      pendingPreview = null;
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

// ─── Notifications ────────────────────────────────────────────────────────────

chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup().catch(() => {});
});

chrome.notifications.onButtonClicked.addListener((_id, buttonIndex) => {
  if (buttonIndex === 0) chrome.action.openPopup().catch(() => {});
});

// ─── Alarms — Token Refresh ───────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTH_REFRESH_ALARM) {
    await authManager.handleRefreshAlarm();
  }
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
