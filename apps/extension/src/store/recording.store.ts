import { create } from 'zustand';
import type {
  RecordingStatus,
  RecordingType,
  ScreenshotCaptureType,
  RecordingOptions,
  UploadProgress,
  Recording,
} from '@/types';
import type { ExtensionMessage } from '@/types';
import { STORAGE_KEYS } from '@/types';

interface RecordingStore {
  status: RecordingStatus;
  recordingType: RecordingType | null;
  duration: number;
  uploadProgress: UploadProgress | null;
  shareUrl: string | null;
  recordings: Recording[];
  currentRecordingId: string | null;
  error: string | null;
  isMicMuted: boolean;
  isWebcamVisible: boolean;

  // Project selection state
  selectedProjectName: string | null;
  setSelectedProjectName: (projectName: string | null) => void;

  // Bug report state
  annotationScreenshot: string | null;
  setAnnotationScreenshot: (url: string | null) => void;

  initialize: () => Promise<void>;
  setStatus: (status: RecordingStatus) => void;
  setCurrentRecordingId: (id: string | null) => void;
  startRecording: (options: RecordingOptions) => Promise<void>;
  stopRecording: () => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  takeScreenshot: (screenshotType: ScreenshotCaptureType) => Promise<void>;
  setUploadProgress: (progress: UploadProgress) => void;
  setShareUrl: (url: string) => void;
  setDuration: (duration: number) => void;
  reset: () => void;
  fetchRecordings: () => Promise<void>;
  toggleMic: () => void;
  toggleWebcam: () => void;
  setError: (error: string) => void;
}

function sendMessage<T>(message: ExtensionMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response as T);
    });
  });
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  status: 'idle',
  recordingType: null,
  duration: 0,
  uploadProgress: null,
  shareUrl: null,
  recordings: [],
  currentRecordingId: null,
  error: null,
  isMicMuted: false,
  isWebcamVisible: false,

  // Project selection state
  selectedProjectName: null,
  setSelectedProjectName: (projectName: string | null) => set({ selectedProjectName: projectName }),

  // Bug report state
  annotationScreenshot: null,
  setAnnotationScreenshot: (url: string | null) => set({ annotationScreenshot: url }),

  initialize: async () => {
    // Sync in-progress recording state from background service worker
    try {
      const bgState = await sendMessage<{
        isRecording: boolean;
        isPaused: boolean;
        elapsedSeconds: number;
        recordingId: string | null;
      }>({ type: 'GET_STATE' });
      if (bgState?.isRecording) {
        set({
          status: bgState.isPaused ? 'paused' : 'recording',
          currentRecordingId: bgState.recordingId,
          duration: bgState.elapsedSeconds,
        });
      }
    } catch {
      // Background not ready yet — ignore
    }

    // Pick up any share result that completed while popup was closed
    try {
      const result = await chrome.storage.local.get([STORAGE_KEYS.PENDING_SHARE]);
      const pending = result[STORAGE_KEYS.PENDING_SHARE] as
        | { shareUrl: string; recordingId: string | null }
        | undefined;
      if (pending?.shareUrl) {
        set({
          shareUrl: pending.shareUrl,
          currentRecordingId: pending.recordingId ?? null,
          status: 'done',
          uploadProgress: null,
        });
        await chrome.storage.local.remove([STORAGE_KEYS.PENDING_SHARE]);
      }
    } catch {
      // Storage unavailable — ignore
    }
  },

  setStatus: (status: RecordingStatus) => set({ status }),

  setCurrentRecordingId: (id: string | null) => set({ currentRecordingId: id }),

  startRecording: async (options: RecordingOptions) => {
    set({ status: 'requesting', error: null, recordingType: options.type });
    try {
      const response = await sendMessage<{ recordingId: string }>({
        type: 'START_RECORDING',
        payload: { options },
      });
      set({
        status: 'recording',
        currentRecordingId: response.recordingId,
        duration: 0,
        // Mic starts muted only when it was disabled for this recording.
        isMicMuted: !options.micEnabled,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to start recording';
      set({ status: 'error', error, recordingType: null });
      throw err;
    }
  },

  stopRecording: async () => {
    set({ status: 'stopping' });
    try {
      await sendMessage({ type: 'STOP_RECORDING' });
      set({ status: 'uploading' });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to stop recording';
      set({ status: 'error', error });
      throw err;
    }
  },

  pauseRecording: () => {
    chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    set({ status: 'paused' });
  },

  resumeRecording: () => {
    chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    set({ status: 'recording' });
  },

  takeScreenshot: async (screenshotType: ScreenshotCaptureType): Promise<void> => {
    // Query the active tab NOW, while the popup is still open and is the frontmost window.
    // The background service worker cannot reliably use currentWindow:true (no window context),
    // so we resolve the tab here and embed it in the payload.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.runtime.sendMessage({
        type: 'TAKE_SCREENSHOT',
        payload: {
          screenshotType,
          tabId: tab?.id,
          windowId: tab?.windowId,
        },
      });
    } catch {
      // ignore — background will try lastFocusedWindow as fallback
      chrome.runtime.sendMessage({
        type: 'TAKE_SCREENSHOT',
        payload: { screenshotType },
      });
    }
  },

  setUploadProgress: (progress: UploadProgress) => {
    set({ uploadProgress: progress, status: 'uploading' });
  },

  setShareUrl: (url: string) => {
    set({ shareUrl: url, status: 'done', uploadProgress: null });
  },

  setDuration: (duration: number) => {
    set({ duration });
  },

  reset: () => {
    set({
      status: 'idle',
      recordingType: null,
      duration: 0,
      uploadProgress: null,
      shareUrl: null,
      currentRecordingId: null,
      error: null,
      selectedProjectName: null,
    });
  },

  fetchRecordings: async () => {
    // Guard: only fetch if we have a stored access token
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
      const tokens = stored[STORAGE_KEYS.AUTH_TOKENS] as { accessToken?: string } | undefined;
      if (!tokens?.accessToken) return;
    } catch {
      return;
    }
    try {
      const { recordingsApi } = await import('@/services/api');
      const result = await recordingsApi.list(1, 20);
      set({ recordings: result.data });
    } catch (err) {
      // Silently ignore network errors — backend may not be reachable yet
      if ((err as { code?: string })?.code !== 'ERR_NETWORK') {
        console.error('[RecordingStore] fetchRecordings error:', err);
      }
    }
  },

  toggleMic: () => {
    const { isMicMuted } = get();
    const muted = !isMicMuted;
    // Mute the mic track in the offscreen recorder without pausing the recording.
    chrome.runtime.sendMessage({ type: 'SET_MIC_MUTED', payload: { muted } });
    set({ isMicMuted: muted });
  },

  toggleWebcam: () => {
    set((state) => ({ isWebcamVisible: !state.isWebcamVisible }));
  },

  setError: (error: string) => {
    set({ status: 'error', error });
  },
}));

// Listen for messages from background service worker
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
    const store = useRecordingStore.getState();

    switch (message.type) {
      case 'UPLOAD_PROGRESS': {
        const progress = message.payload as UploadProgress;
        store.setUploadProgress(progress);
        break;
      }
      case 'UPLOAD_COMPLETE': {
        const { shareUrl, recordingId } = message.payload as {
          shareUrl: string;
          recordingId?: string;
        };
        if (recordingId) store.setCurrentRecordingId(recordingId);
        store.setShareUrl(shareUrl);
        break;
      }
      case 'UPDATE_TIMER': {
        const { duration } = message.payload as { duration: number };
        store.setDuration(duration);
        break;
      }
      case 'RECORDING_ERROR': {
        store.setError(message.error ?? 'Recording error occurred');
        break;
      }
    }
  });
}
