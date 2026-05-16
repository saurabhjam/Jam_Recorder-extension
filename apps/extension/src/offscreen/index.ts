/**
 * SnapTrace — Offscreen Document (Manifest V3)
 *
 * This document runs in a hidden browser page that has access to all
 * Web APIs unavailable in the service worker:
 *   - navigator.mediaDevices.getUserMedia
 *   - MediaRecorder
 *   - AudioContext
 *   - ImageCapture / OffscreenCanvas
 *
 * Communication protocol:
 *   Background → Offscreen: chrome.runtime.sendMessage with target='offscreen'
 *   Offscreen → Background: chrome.runtime.sendMessage with target='background'
 *
 * The offscreen document also owns the entire upload lifecycle so that blob
 * data never has to cross the message boundary to the background service worker.
 */

import type { RecordingOptions, RecordingQuality, UploadProgress, AuthTokens } from '@/types';
import { QUALITY_PRESETS, STORAGE_KEYS, toBackendRecordingType } from '@/types';
import { generateId, retryWithBackoff, sleep } from '@/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StartRecordingPayload {
  options: RecordingOptions;
  streamId?: string; // from desktopCapture or tabCapture
  recordingId: string;
}

interface OffscreenIncomingMessage {
  target: string;
  type: string;
  payload?: unknown;
}

// ─── API Config (mirrors services/api.ts) ─────────────────────────────────────

const API_BASE_URL: string = (() => {
  try {
    const env = (import.meta as { env?: Record<string, string> }).env;
    return env?.['VITE_API_BASE_URL'] ?? 'http://localhost:3000/api';
  } catch {
    return 'http://localhost:3000/api';
  }
})();

async function getAccessToken(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
    const tokens = result[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;

    if (!tokens?.accessToken) return null;

    // Token is still valid — return it directly
    if (tokens.expiresAt > Date.now() + 10_000) {
      return tokens.accessToken;
    }

    // Token expired or expiring within 10s — try to silently refresh
    if (!tokens.refreshToken) return null;

    const refreshRes = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });

    if (!refreshRes.ok) {
      // Refresh rejected — clear stale tokens so popup shows login view
      await chrome.storage.local.remove([
        STORAGE_KEYS.AUTH_TOKENS,
        STORAGE_KEYS.AUTH_USER,
        STORAGE_KEYS.AUTH_SESSION_ID,
      ]);
      sendToBackground('AUTH_STATE_CHANGED', { isAuthenticated: false });
      return null;
    }

    const body = (await refreshRes.json()) as { data: { tokens: AuthTokens } };
    const newTokens = body.data.tokens;
    if (!newTokens?.accessToken) return null;

    await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKENS]: newTokens });
    // Notify background to reschedule the refresh alarm
    sendToBackground('TOKEN_REFRESHED', { expiresAt: newTokens.expiresAt });
    return newTokens.accessToken;
  } catch {
    return null;
  }
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── State ────────────────────────────────────────────────────────────────────

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let webcamStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let chunks: Blob[] = [];
let mimeType = 'video/webm';
let activeRecordingId: string | null = null;
let isRecordingActive = false;
let lastThumbnailDataUrl: string | null = null;

// ─── MIME Type Selection ──────────────────────────────────────────────────────

const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4',
];

function getSupportedMimeType(): string {
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

// ─── Stream Building ──────────────────────────────────────────────────────────

async function buildCaptureStream(
  options: RecordingOptions,
  streamId?: string,
): Promise<MediaStream> {
  const preset: { width: number; height: number; frameRate: number } =
    QUALITY_PRESETS[options.quality];

  if (options.type === 'screen' || options.type === 'tab') {
    if (!streamId) throw new Error('streamId required for screen/tab recording');
    const source = options.type === 'screen' ? 'desktop' : 'tab';

    return navigator.mediaDevices.getUserMedia({
      video: {
        // @ts-expect-error — Chrome-specific mandatory constraints
        mandatory: {
          chromeMediaSource: source,
          chromeMediaSourceId: streamId,
          maxWidth: preset.width,
          maxHeight: preset.height,
          maxFrameRate: preset.frameRate,
        },
      },
      audio: options.systemAudio
        ? {
            // @ts-expect-error — Chrome-specific mandatory constraints
            mandatory: {
              chromeMediaSource: source,
              chromeMediaSourceId: streamId,
            },
          }
        : false,
    });
  }

  if (options.type === 'webcam') {
    return navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        frameRate: { ideal: preset.frameRate },
        facingMode: 'user',
      },
      audio: options.micEnabled
        ? { echoCancellation: true, noiseSuppression: true, sampleRate: 48_000 }
        : false,
    });
  }

  throw new Error(`Unsupported recording type: ${options.type}`);
}

function mergeAudioTracks(tracks: MediaStreamTrack[]): MediaStreamTrack {
  audioContext = new AudioContext();
  const dest = audioContext.createMediaStreamDestination();
  for (const track of tracks) {
    audioContext.createMediaStreamSource(new MediaStream([track])).connect(dest);
  }
  return dest.stream.getAudioTracks()[0]!;
}

async function buildFinalStream(
  captureStream: MediaStream,
  options: RecordingOptions,
): Promise<MediaStream> {
  const videoTracks = captureStream.getVideoTracks();
  const audioTracks: MediaStreamTrack[] = [...captureStream.getAudioTracks()];

  // Add microphone for screen/tab recordings
  if (options.micEnabled && options.type !== 'webcam') {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48_000 },
        video: false,
      });
      audioTracks.push(...micStream.getAudioTracks());
    } catch {
      console.warn('[Offscreen] Microphone denied, continuing without mic');
    }
  }

  // Add webcam overlay track (secondary video; compositor would blend it client-side)
  if (options.webcamOverlay && options.type !== 'webcam') {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
        audio: false,
      });
    } catch {
      console.warn('[Offscreen] Webcam overlay denied');
    }
  }

  const finalTracks: MediaStreamTrack[] = [...videoTracks];

  if (audioTracks.length > 1) {
    finalTracks.push(mergeAudioTracks(audioTracks));
  } else if (audioTracks.length === 1) {
    finalTracks.push(audioTracks[0]!);
  }

  return new MediaStream(finalTracks);
}

// ─── Recording Lifecycle ──────────────────────────────────────────────────────

async function startRecording(payload: StartRecordingPayload): Promise<void> {
  if (isRecordingActive) {
    throw new Error('A recording is already in progress in offscreen');
  }

  const { options, streamId, recordingId } = payload;

  chunks = [];
  mimeType = getSupportedMimeType();
  activeRecordingId = recordingId;
  isRecordingActive = true;

  const captureStream = await buildCaptureStream(options, streamId);
  stream = captureStream;

  const finalStream = await buildFinalStream(captureStream, options);
  const preset = QUALITY_PRESETS[options.quality];

  recorder = new MediaRecorder(finalStream, {
    mimeType,
    videoBitsPerSecond: preset.videoBitrate,
    audioBitsPerSecond: 128_000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onerror = (e) => {
    console.error('[Offscreen] MediaRecorder error:', e.error);
    sendToBackground('OFFSCREEN_ERROR', { error: e.error?.message ?? 'MediaRecorder error' });
  };

  // 1-second timeslices for consistent chunking
  recorder.start(1000);
}

function pauseRecording(): void {
  if (recorder?.state === 'recording') {
    recorder.pause();
  }
}

function resumeRecording(): void {
  if (recorder?.state === 'paused') {
    recorder.resume();
  }
}

async function stopRecording(metadata: {
  title: string;
  type: string;
  duration: number;
  quality: RecordingQuality;
  hasAudio: boolean;
  hasWebcam: boolean;
}): Promise<void> {
  if (!recorder || !isRecordingActive) {
    throw new Error('No active recording');
  }

  const finalBlob = await new Promise<Blob>((resolve, reject) => {
    recorder!.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };
    recorder!.onerror = (e) => {
      reject(new Error(e.error?.message ?? 'Stop error'));
    };
    if (recorder!.state !== 'inactive') {
      recorder!.stop();
    } else {
      resolve(new Blob(chunks, { type: mimeType }));
    }
  });

  cleanup();

  // Generate thumbnail and open the panel immediately so the user sees something
  const thumbnailDataUrl = await generateThumbnail(finalBlob);
  lastThumbnailDataUrl = thumbnailDataUrl; // keep for offline queue retry
  sendToBackground('OFFSCREEN_RECORDING_READY', {
    thumbnailDataUrl,
    duration: metadata.duration,
    blobSize: finalBlob.size,
    shareUrl: null, // shareUrl will follow once the recording row is created
  });

  await uploadBlob(finalBlob, {
    ...metadata,
    type: metadata.type as RecordingOptions['type'],
    mimeType,
  });
}

async function generateThumbnail(blob: Blob): Promise<string | null> {
  if (!blob.type.startsWith('video/') || blob.size === 0) return null;
  try {
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.src = objectUrl;
    video.muted = true;
    video.preload = 'metadata';

    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Video load failed'));
      setTimeout(() => resolve(), 3000); // 3s timeout
    });

    video.currentTime = 0.1;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      setTimeout(() => resolve(), 1000);
    });

    const canvas = document.createElement('canvas');
    const width = Math.min(video.videoWidth || 1280, 960);
    const height = Math.round(width * (video.videoHeight / (video.videoWidth || 1)));
    canvas.width = width;
    canvas.height = height || 540;
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);

    URL.revokeObjectURL(objectUrl);
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch {
    return null;
  }
}

function cleanup(): void {
  stream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  webcamStream?.getTracks().forEach((t) => t.stop());
  audioContext?.close();

  stream = null;
  micStream = null;
  webcamStream = null;
  audioContext = null;
  recorder = null;
  chunks = [];
  isRecordingActive = false;
  activeRecordingId = null;
  lastThumbnailDataUrl = null;
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

async function takeScreenshot(streamId: string): Promise<void> {
  let captureStream: MediaStream | null = null;
  try {
    captureStream = await navigator.mediaDevices.getUserMedia({
      video: {
        // @ts-expect-error — Chrome-specific mandatory constraints
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
        },
      },
      audio: false,
    });

    const track = captureStream.getVideoTracks()[0];
    if (!track) throw new Error('No video track for screenshot');

    let pngBlob: Blob;

    if (typeof ImageCapture !== 'undefined') {
      const cap = new ImageCapture(track);
      const bitmap = await cap.grabFrame();
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    } else {
      // Fallback via video element (available in offscreen)
      const video = document.createElement('video');
      video.srcObject = captureStream;
      await new Promise<void>((res) => {
        video.onloadedmetadata = () => res();
      });
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      video.pause();
      pngBlob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
      );
    }

    await uploadBlob(pngBlob, {
      title: `Screenshot ${new Date().toLocaleString()}`,
      type: 'screenshot',
      mimeType: 'image/png',
      duration: 0,
      quality: 'high',
      hasAudio: false,
      hasWebcam: false,
    });
  } finally {
    captureStream?.getTracks().forEach((t) => t.stop());
  }
}

// ─── Upload (runs entirely in offscreen — no blob transfer needed) ─────────────

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB

interface UploadMetadata {
  title: string;
  type: RecordingOptions['type'];
  duration: number;
  mimeType: string;
  quality: RecordingQuality;
  hasAudio: boolean;
  hasWebcam: boolean;
}

const DASHBOARD_URL = 'http://localhost:3001';

async function uploadBlob(blob: Blob, metadata: UploadMetadata): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    // Save to queue so upload retries automatically after user signs in
    await saveToOfflineQueue(blob, metadata, lastThumbnailDataUrl);
    sendToBackground('OFFSCREEN_ERROR', { error: 'Not authenticated — cannot upload' });
    return;
  }

  const blobChunks = splitBlob(blob);
  const totalChunks = blobChunks.length;
  const totalBytes = blob.size;

  let recordingId: string;
  let shareId: string;

  try {
    const init = await retryWithBackoff(
      () => createRecordingAndInitiate(token, metadata, totalChunks),
      3,
    );
    recordingId = init.recordingId;
    shareId = init.shareId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload init failed';
    sendToBackground('OFFSCREEN_ERROR', { error: msg });
    await saveToOfflineQueue(blob, metadata);
    return;
  }

  const shareUrl = `${DASHBOARD_URL}/share/${shareId}`;

  // Push the share URL to the already-open panel (second OFFSCREEN_RECORDING_READY updates it)
  sendToBackground('OFFSCREEN_RECORDING_READY', {
    thumbnailDataUrl: null, // thumbnail already set; background will preserve existing value
    duration: metadata.duration,
    blobSize: blob.size,
    shareUrl,
    recordingId,
  });

  let uploadedBytes = 0;
  let uploadedChunks = 0;

  // Upload chunks
  for (let i = 0; i < blobChunks.length; i++) {
    const chunk = blobChunks[i]!;
    try {
      await retryWithBackoff(
        () =>
          uploadChunk(token, recordingId, i, totalChunks, chunk, (pct) => {
            const approxBytes = uploadedBytes + (pct / 100) * chunk.size;
            const progress: UploadProgress = {
              recordingId,
              totalChunks,
              uploadedChunks: i,
              totalBytes,
              uploadedBytes: Math.round(approxBytes),
              speed: 0,
              percentComplete: Math.round((approxBytes / totalBytes) * 100),
              eta: 0,
            };
            sendToBackground('OFFSCREEN_UPLOAD_PROGRESS', progress);
          }),
        3,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chunk upload failed';
      sendToBackground('OFFSCREEN_ERROR', { error: `Chunk ${i} failed: ${msg}` });
      return;
    }

    uploadedBytes += chunk.size;
    uploadedChunks = i + 1;

    sendToBackground('OFFSCREEN_UPLOAD_PROGRESS', {
      recordingId,
      totalChunks,
      uploadedChunks,
      totalBytes,
      uploadedBytes,
      speed: 0,
      percentComplete: Math.round((uploadedBytes / totalBytes) * 100),
      eta: 0,
    } satisfies UploadProgress);
  }

  // Finalize
  try {
    await retryWithBackoff(() => finalizeUpload(token, recordingId), 3);

    sendToBackground('OFFSCREEN_UPLOAD_PROGRESS', {
      recordingId,
      totalChunks,
      uploadedChunks: totalChunks,
      totalBytes,
      uploadedBytes: totalBytes,
      speed: 0,
      percentComplete: 100,
      eta: 0,
    } satisfies UploadProgress);

    sendToBackground('OFFSCREEN_UPLOAD_COMPLETE', { shareUrl, recordingId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Finalize failed';
    sendToBackground('OFFSCREEN_ERROR', { error: msg });
  }
}

async function createRecordingAndInitiate(
  token: string,
  metadata: UploadMetadata,
  totalChunks: number,
): Promise<{ recordingId: string; shareId: string }> {
  // Create recording
  const createRes = await fetch(`${API_BASE_URL}/recordings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      title: metadata.title,
      type: toBackendRecordingType(metadata.type),
      totalChunks,
      mimeType: metadata.mimeType,
    }),
  });
  if (!createRes.ok) {
    const err = (await createRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(err.message ?? `Create recording failed: ${createRes.status}`);
  }
  const createData = (await createRes.json()) as { data: { id: string; shareId: string } };
  const recordingId = createData.data.id;
  const shareId = createData.data.shareId ?? recordingId;

  // Initiate upload session
  const initiateRes = await fetch(`${API_BASE_URL}/uploads/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ recordingId, totalChunks, mimeType: metadata.mimeType }),
  });
  if (!initiateRes.ok) {
    const err = (await initiateRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(err.message ?? `Initiate upload failed: ${initiateRes.status}`);
  }

  return { recordingId, shareId };
}

async function uploadChunk(
  token: string,
  recordingId: string,
  chunkIndex: number,
  totalChunks: number,
  chunk: Blob,
  onProgress: (pct: number) => void,
): Promise<void> {
  const formData = new FormData();
  formData.append('chunk', chunk, `chunk-${chunkIndex}`);

  const url = `${API_BASE_URL}/uploads/chunk?recordingId=${encodeURIComponent(recordingId)}&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`;

  // Use XMLHttpRequest to get upload progress events
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded * 100) / e.total));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Chunk upload ${chunkIndex} failed: ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error(`Network error uploading chunk ${chunkIndex}`));
    xhr.send(formData);
  });
}

async function finalizeUpload(token: string, recordingId: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/uploads/complete/${encodeURIComponent(recordingId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(err.message ?? `Finalize failed: ${res.status}`);
  }
}

// ─── Blob Utilities ───────────────────────────────────────────────────────────

function splitBlob(blob: Blob): Blob[] {
  const result: Blob[] = [];
  let offset = 0;
  while (offset < blob.size) {
    result.push(blob.slice(offset, offset + CHUNK_SIZE, blob.type));
    offset += CHUNK_SIZE;
  }
  return result;
}

// ─── Offline Queue ────────────────────────────────────────────────────────────

interface QueuedUpload {
  id: string;
  blobBase64: string;
  metadata: UploadMetadata;
  timestamp: number;
  thumbnailDataUrl: string | null;
}

async function saveToOfflineQueue(
  blob: Blob,
  metadata: UploadMetadata,
  thumbnailDataUrl?: string | null,
): Promise<void> {
  try {
    const base64 = await blobToBase64(blob);
    const item: QueuedUpload = {
      id: generateId(12),
      blobBase64: base64,
      metadata,
      timestamp: Date.now(),
      thumbnailDataUrl: thumbnailDataUrl ?? null,
    };
    const result = await chrome.storage.local.get([STORAGE_KEYS.OFFLINE_QUEUE]);
    const queue = (result[STORAGE_KEYS.OFFLINE_QUEUE] as QueuedUpload[]) ?? [];
    await chrome.storage.local.set({
      [STORAGE_KEYS.OFFLINE_QUEUE]: [item, ...queue].slice(0, 5),
    });
  } catch (err) {
    console.error('[Offscreen] Failed to save offline queue:', err);
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

async function processOfflineQueue(): Promise<void> {
  const result = await chrome.storage.local.get([STORAGE_KEYS.OFFLINE_QUEUE]);
  const queue = (result[STORAGE_KEYS.OFFLINE_QUEUE] as QueuedUpload[]) ?? [];
  if (queue.length === 0) return;

  const succeeded: string[] = [];
  for (const item of queue) {
    try {
      const blob = base64ToBlob(item.blobBase64, item.metadata.mimeType);
      // Restore thumbnail so the panel reopens with preview intact
      lastThumbnailDataUrl = item.thumbnailDataUrl;
      sendToBackground('OFFSCREEN_RECORDING_READY', {
        thumbnailDataUrl: item.thumbnailDataUrl,
        duration: item.metadata.duration,
        blobSize: blob.size,
        shareUrl: null,
      });
      await sleep(100); // give background time to push to tab before progress starts
      await uploadBlob(blob, item.metadata);
      succeeded.push(item.id);
      await sleep(500);
    } catch (err) {
      console.error('[Offscreen] Offline queue item failed:', item.id, err);
    }
  }

  const remaining = queue.filter((q) => !succeeded.includes(q.id));
  await chrome.storage.local.set({ [STORAGE_KEYS.OFFLINE_QUEUE]: remaining });
}

// ─── Message Dispatcher ───────────────────────────────────────────────────────

function sendToBackground(type: string, payload?: unknown): void {
  chrome.runtime.sendMessage({ target: 'background', type, payload }).catch(() => {
    // Background may be idle — safe to ignore
  });
}

chrome.runtime.onMessage.addListener((message: OffscreenIncomingMessage, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  switch (message.type) {
    case 'OFFSCREEN_START_RECORDING': {
      const payload = message.payload as StartRecordingPayload;
      startRecording(payload)
        .then(() => sendResponse({ success: true }))
        .catch((err: Error) => {
          cleanup();
          sendResponse({ error: err.message });
        });
      return true;
    }

    case 'OFFSCREEN_STOP_RECORDING': {
      const meta = message.payload as {
        title: string;
        type: string;
        duration: number;
        quality: RecordingQuality;
        hasAudio: boolean;
        hasWebcam: boolean;
      };
      stopRecording(meta)
        .then(() => sendResponse({ success: true }))
        .catch((err: Error) => sendResponse({ error: err.message }));
      return true;
    }

    case 'OFFSCREEN_PAUSE_RECORDING': {
      pauseRecording();
      sendResponse({ success: true });
      return false;
    }

    case 'OFFSCREEN_RESUME_RECORDING': {
      resumeRecording();
      sendResponse({ success: true });
      return false;
    }

    case 'OFFSCREEN_TAKE_SCREENSHOT': {
      const { streamId } = message.payload as { streamId: string };
      takeScreenshot(streamId)
        .then(() => sendResponse({ success: true }))
        .catch((err: Error) => sendResponse({ error: err.message }));
      return true;
    }

    case 'OFFSCREEN_PROCESS_QUEUE': {
      processOfflineQueue()
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }

    default:
      return false;
  }
});
