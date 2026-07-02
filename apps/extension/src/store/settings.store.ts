import { create } from 'zustand';
import type { ExtensionSettings, RecordingQuality } from '@/types';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/types';

interface SettingsStore {
  settings: ExtensionSettings;
  isLoading: boolean;

  initialize: () => Promise<void>;
  updateSettings: (updates: Partial<ExtensionSettings>) => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleWebcam: () => Promise<void>;
  toggleSystemAudio: () => Promise<void>;
  setQuality: (quality: RecordingQuality) => Promise<void>;
  resetSettings: () => Promise<void>;
}

async function persistSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

/**
 * Map legacy quality values (low/medium/high/4k) onto the resolution-based ones
 * so users who saved settings before the switch keep a sensible resolution.
 * Anything unrecognized falls back to the 720p default.
 */
function migrateQuality(q: unknown): RecordingQuality {
  const legacy: Record<string, RecordingQuality> = {
    low: '480p',
    medium: '720p',
    high: '1080p',
    '4k': '1080p', // capped at 1080p
  };
  if (q === '480p' || q === '720p' || q === '1080p') return q;
  return (typeof q === 'string' && legacy[q]) || '720p';
}

/** Path of the dedicated mic-permission page (opened in a real tab). */
export const MIC_PERMISSION_PAGE = 'src/permission/index.html';

/**
 * Current microphone permission state for the extension origin.
 * Returns 'unknown' if the Permissions API can't answer (treat as best-effort).
 */
export async function getMicPermissionState(): Promise<PermissionState | 'unknown'> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/** Open the permission page in a new tab so the user can grant mic access. */
export async function openMicPermissionPage(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(MIC_PERMISSION_PAGE) });
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isLoading: false,

  initialize: async () => {
    set({ isLoading: true });
    try {
      const result = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS]);
      const stored = result[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined;

      if (stored) {
        // Merge with defaults to handle new settings fields
        const merged: ExtensionSettings = { ...DEFAULT_SETTINGS, ...stored };
        merged.recordingQuality = migrateQuality(merged.recordingQuality);
        set({ settings: merged, isLoading: false });
        // Persist the migrated value so it sticks after the first load.
        if (merged.recordingQuality !== stored.recordingQuality) {
          await persistSettings(merged);
        }
      } else {
        // Save defaults on first run
        await persistSettings(DEFAULT_SETTINGS);
        set({ settings: DEFAULT_SETTINGS, isLoading: false });
      }
    } catch (err) {
      console.error('[SettingsStore] Initialize error:', err);
      set({ isLoading: false });
    }
  },

  updateSettings: async (updates: Partial<ExtensionSettings>) => {
    const current = get().settings;
    const next = { ...current, ...updates };
    set({ settings: next });
    await persistSettings(next);
  },

  toggleMic: async () => {
    const { settings, updateSettings } = get();
    const enabling = !settings.micEnabled;

    // Reflect the choice immediately so the toggle is responsive.
    await updateSettings({ micEnabled: enabling });
    if (!enabling) return;

    // The popup can't surface the mic permission prompt (it closes when the
    // prompt steals focus), so when access isn't already granted we hand off
    // to a dedicated permission tab. It writes the final state back to storage.
    const state = await getMicPermissionState();
    if (state !== 'granted') {
      await openMicPermissionPage();
    }
  },

  toggleWebcam: async () => {
    const { settings, updateSettings } = get();
    const enabling = !settings.webcamOverlay;
    if (enabling) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        return;
      }
    }
    await updateSettings({ webcamOverlay: enabling });
  },

  toggleSystemAudio: async () => {
    const { settings, updateSettings } = get();
    await updateSettings({ systemAudio: !settings.systemAudio });
  },

  setQuality: async (quality: RecordingQuality) => {
    await get().updateSettings({ recordingQuality: quality });
  },

  resetSettings: async () => {
    set({ settings: DEFAULT_SETTINGS });
    await persistSettings(DEFAULT_SETTINGS);
  },
}));

// Sync the mic toggle live when the permission page reports its result.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: { type?: string; payload?: unknown }) => {
    if (message?.type === 'MIC_PERMISSION_RESULT') {
      const { granted } = (message.payload as { granted?: boolean }) ?? {};
      const { settings } = useSettingsStore.getState();
      useSettingsStore.setState({ settings: { ...settings, micEnabled: !!granted } });
    }
  });
}
