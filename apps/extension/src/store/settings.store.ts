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
        set({
          settings: { ...DEFAULT_SETTINGS, ...stored },
          isLoading: false,
        });
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
    if (enabling) {
      try {
        // Request permission — stream is immediately stopped; we only need the grant
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        // User denied — don't toggle on
        return;
      }
    }
    await updateSettings({ micEnabled: enabling });
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
