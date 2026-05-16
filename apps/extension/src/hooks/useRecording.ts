import { useCallback, useEffect } from 'react';
import { useRecordingStore } from '@/store/recording.store';
import { useSettingsStore } from '@/store/settings.store';
import { useTimer } from './useTimer';
import type { RecordingType } from '@/types';

interface UseRecordingReturn {
  status: ReturnType<typeof useRecordingStore.getState>['status'];
  recordingType: RecordingType | null;
  formattedTime: string;
  seconds: number;
  uploadProgress: ReturnType<typeof useRecordingStore.getState>['uploadProgress'];
  shareUrl: string | null;
  error: string | null;
  isRecording: boolean;
  isPaused: boolean;
  isUploading: boolean;
  isDone: boolean;
  isMicMuted: boolean;
  isWebcamVisible: boolean;

  handleStartScreen: () => Promise<void>;
  handleStartTab: () => Promise<void>;
  handleStartWebcam: () => Promise<void>;
  handleStop: () => Promise<void>;
  handlePause: () => void;
  handleResume: () => void;
  handleScreenshot: () => Promise<void>;
  handleReset: () => void;
  toggleMic: () => void;
  toggleWebcam: () => void;
}

export function useRecording(): UseRecordingReturn {
  const {
    status,
    recordingType,
    duration,
    uploadProgress,
    shareUrl,
    error,
    isMicMuted,
    isWebcamVisible,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    takeScreenshot,
    setDuration,
    reset,
    toggleMic,
    toggleWebcam,
  } = useRecordingStore();

  const { settings } = useSettingsStore();

  const timer = useTimer({ initialSeconds: duration });

  // Sync timer with store
  useEffect(() => {
    if (status === 'recording' && !timer.isRunning) {
      timer.start();
    } else if (status === 'paused' && timer.isRunning) {
      timer.pause();
    } else if (status === 'idle' || status === 'done' || status === 'error') {
      timer.reset();
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep store duration in sync with timer
  useEffect(() => {
    if (status === 'recording') {
      setDuration(timer.seconds);
    }
  }, [timer.seconds, status, setDuration]);

  const handleStartScreen = useCallback(async () => {
    await startRecording({
      type: 'screen',
      quality: settings.recordingQuality,
      micEnabled: settings.micEnabled,
      webcamOverlay: settings.webcamOverlay,
      systemAudio: settings.systemAudio,
    });
  }, [startRecording, settings]);

  const handleStartTab = useCallback(async () => {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await startRecording({
      type: 'tab',
      quality: settings.recordingQuality,
      micEnabled: settings.micEnabled,
      webcamOverlay: settings.webcamOverlay,
      systemAudio: settings.systemAudio,
      tabId: activeTab?.id,
    });
  }, [startRecording, settings]);

  const handleStartWebcam = useCallback(async () => {
    await startRecording({
      type: 'webcam',
      quality: settings.recordingQuality,
      micEnabled: settings.micEnabled,
      webcamOverlay: false,
      systemAudio: false,
    });
  }, [startRecording, settings]);

  const handleStop = useCallback(async () => {
    timer.pause();
    await stopRecording();
  }, [timer, stopRecording]);

  const handlePause = useCallback(() => {
    timer.pause();
    pauseRecording();
  }, [timer, pauseRecording]);

  const handleResume = useCallback(() => {
    timer.resume();
    resumeRecording();
  }, [timer, resumeRecording]);

  const handleScreenshot = useCallback(async () => {
    await takeScreenshot();
  }, [takeScreenshot]);

  const handleReset = useCallback(() => {
    timer.reset();
    reset();
  }, [timer, reset]);

  return {
    status,
    recordingType,
    formattedTime: timer.formattedTime,
    seconds: timer.seconds,
    uploadProgress,
    shareUrl,
    error,
    isRecording: status === 'recording',
    isPaused: status === 'paused',
    isUploading: status === 'uploading',
    isDone: status === 'done',
    isMicMuted,
    isWebcamVisible,

    handleStartScreen,
    handleStartTab,
    handleStartWebcam,
    handleStop,
    handlePause,
    handleResume,
    handleScreenshot,
    handleReset,
    toggleMic,
    toggleWebcam,
  };
}
