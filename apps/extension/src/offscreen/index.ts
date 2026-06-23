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
import { STORAGE_KEYS } from '@/types';
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

// ─── API Config ───────────────────────────────────────────────────────────────

// ReportPortal Java API — recordings, uploads, user info
const RP_HOST = 'https://reportsv1.best-quality.in';
const REPORTS_URL: string = (() => {
  try {
    const env = (import.meta as { env?: Record<string, string> }).env;
    return env?.['VITE_API_BASE_URL'] ?? `${RP_HOST}/api`;
  } catch {
    return `${RP_HOST}/api`;
  }
})();

// ReportPortal SSO — used for silent token refresh
const SSO_TOKEN_URL = `${RP_HOST}/uat/sso/oauth/token`;
const SSO_AUTH_HEADER = 'Basic dWk6dWltYW4=';

async function getProject(token: string): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(['st_auth_project']);
    const cached = stored['st_auth_project'] as string | undefined;
    if (cached) return cached;

    const res = await fetch(`${REPORTS_URL}/users?ids=`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const raw = (await res.json()) as
        | { assignedProjects?: Record<string, unknown> }
        | Array<{ assignedProjects?: Record<string, unknown> }>;
      const projects = Array.isArray(raw) ? raw[0]?.assignedProjects : raw?.assignedProjects;
      const name = Object.keys(projects ?? {})[0];
      if (name) {
        await chrome.storage.local.set({ st_auth_project: name });
        return name;
      }
    }
  } catch {
    /* fall through */
  }
  return 'superadmin_personal';
}

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

    const refreshRes = await fetch(SSO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: SSO_AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }).toString(),
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

    const sso = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const newTokens: AuthTokens = {
      accessToken: sso.access_token,
      refreshToken: sso.refresh_token,
      expiresAt: Date.now() + sso.expires_in * 1000,
    };
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
let stream: MediaStream | null = null; // the combined stream handed to MediaRecorder
let captureStream: MediaStream | null = null; // raw screen/tab capture (video + system audio)
let micStream: MediaStream | null = null; // raw microphone capture
let webcamStream: MediaStream | null = null;
let audioContext: AudioContext | null = null; // mixes mic + system audio into one track
let chunks: Blob[] = [];
let mimeType = 'video/webm';
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

// async function buildCaptureStream(
//   options: RecordingOptions,
//   streamId?: string,
// ): Promise<MediaStream> {
//   const preset: { width: number; height: number; frameRate: number } =
//     QUALITY_PRESETS[options.quality];

//   if (options.type === 'screen' || options.type === 'tab') {
//     if (!streamId) throw new Error('streamId required for screen/tab recording');
//     const source = options.type === 'screen' ? 'desktop' : 'tab';

//     return navigator.mediaDevices.getUserMedia({
//       video: {
//         // @ts-expect-error — Chrome-specific mandatory constraints
//         mandatory: {
//           chromeMediaSource: source,
//           chromeMediaSourceId: streamId,
//           maxWidth: preset.width,
//           maxHeight: preset.height,
//           maxFrameRate: preset.frameRate,
//         },
//       },
//       audio: options.systemAudio
//         ? {
//             // @ts-expect-error — Chrome-specific mandatory constraints
//             mandatory: {
//               chromeMediaSource: source,
//               chromeMediaSourceId: streamId,
//             },
//           }
//         : false,
//     });
//   }

//   if (options.type === 'webcam') {
//     return navigator.mediaDevices.getUserMedia({
//       video: {
//         width: { ideal: preset.width, max: preset.width },
//         height: { ideal: preset.height, max: preset.height },
//         frameRate: { ideal: preset.frameRate },
//         facingMode: 'user',
//       },
//       audio: options.micEnabled
//         ? { echoCancellation: true, noiseSuppression: true, sampleRate: 48_000 }
//         : false,
//     });
//   }

//   throw new Error(`Unsupported recording type: ${options.type}`);
// }

/**
 * Acquire the primary capture stream (screen or tab) including its system/tab
 * audio. Microphone audio is acquired and mixed separately by
 * {@link createRecordingStream}.
 */
async function acquireCaptureStream(
  options: RecordingOptions,
  streamId?: string,
): Promise<MediaStream> {
  if (options.type === 'screen') {
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'monitor',
        frameRate: 30,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: {
        suppressLocalAudioPlayback: false,
      },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
    } as any);
  }

  return navigator.mediaDevices.getUserMedia({
    // Capture tab audio only when the user opted into system audio. When false
    // we pass `audio: false` so the tab keeps playing through the speakers.
    audio: options.systemAudio
      ? ({
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        } as any)
      : false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as any,
  });
}

/**
 * Acquire the microphone. Returns null if the mic is disabled or permission is
 * denied — recording should continue without mic rather than failing outright.
 *
 * The permission grant must already exist for the extension origin (the popup
 * requests it when the user enables the Mic toggle), because an offscreen
 * document cannot surface a permission prompt itself.
 */
async function acquireMicStream(options: RecordingOptions): Promise<MediaStream | null> {
  if (!options.micEnabled) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48_000,
      },
      video: false,
    });
  } catch (err) {
    console.warn('[Offscreen] Microphone unavailable — recording without mic:', err);
    sendToBackground('OFFSCREEN_MIC_UNAVAILABLE', {
      error: err instanceof Error ? err.message : 'Microphone access denied',
    });
    return null;
  }
}

/**
 * Build the final stream handed to MediaRecorder: the capture video track plus
 * a single audio track. When both system/tab audio and mic audio are present
 * they are mixed through an AudioContext, because MediaRecorder only encodes
 * the first audio track of a stream.
 */
async function createRecordingStream(
  options: RecordingOptions,
  streamId?: string,
): Promise<MediaStream> {
  captureStream = await acquireCaptureStream(options, streamId);
  micStream = await acquireMicStream(options);

  const videoTrack = captureStream.getVideoTracks()[0];
  const systemAudioTracks = captureStream.getAudioTracks();
  const micAudioTracks = micStream?.getAudioTracks() ?? [];

  // No mic → record the capture stream (video + any system audio) untouched.
  if (micAudioTracks.length === 0) {
    return captureStream;
  }

  const tracks: MediaStreamTrack[] = [];
  if (videoTrack) tracks.push(videoTrack);

  if (systemAudioTracks.length === 0) {
    // Mic only → no mixing needed.
    tracks.push(...micAudioTracks);
  } else {
    // Both sources present → mix into one track via the Web Audio graph.
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks)).connect(destination);
    audioContext.createMediaStreamSource(new MediaStream(micAudioTracks)).connect(destination);
    tracks.push(...destination.stream.getAudioTracks());
  }

  return new MediaStream(tracks);
}

/**
 * Mute/unmute the microphone mid-recording without interrupting the recorder.
 * Disabling the track emits silence, which flows through the mix graph too.
 */
function setMicMuted(muted: boolean): void {
  micStream?.getAudioTracks().forEach((t) => {
    t.enabled = !muted;
  });
}

// ─── Recording Lifecycle ──────────────────────────────────────────────────────

async function startRecording(payload: StartRecordingPayload): Promise<void> {
  if (isRecordingActive) {
    throw new Error('A recording is already in progress in offscreen');
  }

  const { options, streamId } = payload;

  chunks = [];
  mimeType = getSupportedMimeType();
  isRecordingActive = true;

  stream = await createRecordingStream(options, streamId);

  recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9,opus',
    videoBitsPerSecond: 8_000_000,
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
  recordingId: string;
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
  lastThumbnailDataUrl = thumbnailDataUrl;

  // Save blob to IDB so the editor window can load it for playback
  try {
    await saveBlobToIDB(metadata.recordingId, finalBlob);
  } catch (err) {
    console.warn('[Offscreen] Could not save blob to IDB:', err);
  }

  sendToBackground('OFFSCREEN_RECORDING_READY', {
    recordingId: metadata.recordingId,
    title: metadata.title,
    thumbnailDataUrl,
    duration: metadata.duration,
    blobSize: finalBlob.size,
    shareUrl: null,
    recordingType: metadata.type,
  });
  // Upload is now triggered explicitly by the editor — offscreen is done here.
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
  captureStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  webcamStream?.getTracks().forEach((t) => t.stop());
  if (audioContext && audioContext.state !== 'closed') {
    void audioContext.close();
  }

  stream = null;
  captureStream = null;
  micStream = null;
  webcamStream = null;
  audioContext = null;
  recorder = null;
  chunks = [];
  isRecordingActive = false;
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

// ─── IndexedDB Blob Storage ────────────────────────────────────────────────────
// Stores the raw recording blob so the editor window can load it for playback.
// All extension pages share the same IDB origin.

const IDB_NAME = 'snaptrace-blobs';
const IDB_STORE = 'recordings';

function openRecordingIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveBlobToIDB(id: string, blob: Blob): Promise<void> {
  const db = await openRecordingIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

interface UploadMetadata {
  title: string;
  type: RecordingOptions['type'];
  duration: number;
  mimeType: string;
  quality: RecordingQuality;
  hasAudio: boolean;
  hasWebcam: boolean;
}

async function uploadBlob(blob: Blob, metadata: UploadMetadata): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    // Save to queue so upload retries automatically after user signs in
    await saveToOfflineQueue(blob, metadata, lastThumbnailDataUrl);
    sendToBackground('OFFSCREEN_ERROR', { error: 'Not authenticated — cannot upload' });
    return;
  }

  const totalBytes = blob.size;
  const project = await getProject(token);
  const ts = Date.now();
  const isoNow = new Date(ts).toISOString();

  let fileName = '';
  let recordingId = '';

  try {
    // Upload blob as a single file → get MinIO filename
    const ext = metadata.mimeType.startsWith('image/') ? 'png' : 'webm';
    const file = new File([blob], `${metadata.type}-${ts}.${ext}`, {
      type: metadata.mimeType.split(';')[0],
    });
    const formData = new FormData();
    formData.append('file', file);

    const uploadRes = await retryWithBackoff(async () => {
      const res = await fetch(`${REPORTS_URL}/v1/${project}/files/upload`, {
        method: 'POST',
        headers: { ...authHeaders(token), Accept: 'text/plain, application/json, */*' },
        body: formData,
      });
      if (!res.ok) throw new Error(`File upload failed: ${res.status}`);
      return (await res.text()).trim();
    }, 3);
    fileName = uploadRes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    sendToBackground('OFFSCREEN_ERROR', { error: msg });
    await saveToOfflineQueue(blob, metadata);
    return;
  }

  try {
    // Create record with all required fields
    const fileUrl = `${REPORTS_URL}/v1/${project}/files/${fileName}`;
    const createBody: Record<string, unknown> = {
      title: metadata.title,
      description: 'Recording captured with SnapTrace',
      type: 'video',
      mimeType: metadata.mimeType.split(';')[0],
      status: 'completed',
      projectId: '1',
      shareId: `share-${ts}`,
      isPublic: false,
      allowDownload: true,
      viewCount: 0,
      url: fileUrl,
      duration: Math.round(metadata.duration ?? 0),
      metadata: JSON.stringify({
        browser: 'chrome',
        source: (metadata.type ?? 'tab').toLowerCase(),
      }),
      createdAt: isoNow,
      updatedAt: isoNow,
    };
    if (lastThumbnailDataUrl) createBody['thumbnailUrl'] = lastThumbnailDataUrl;

    const createRes = await fetch(`${REPORTS_URL}/v1/${project}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(createBody),
    });
    if (!createRes.ok) {
      const e = (await createRes.json().catch(() => ({}))) as { message?: string };
      throw new Error(e.message ?? `Create record failed: ${createRes.status}`);
    }
    const created = (await createRes.json()) as { id: string };
    recordingId = created.id;

    sendToBackground('OFFSCREEN_UPLOAD_PROGRESS', {
      recordingId,
      totalChunks: 1,
      uploadedChunks: 1,
      totalBytes,
      uploadedBytes: totalBytes,
      speed: 0,
      percentComplete: 100,
      eta: 0,
    } satisfies UploadProgress);

    const shareUrl = `${RP_HOST}/ui/#/${project}/records/${recordingId}`;
    sendToBackground('OFFSCREEN_UPLOAD_COMPLETE', { shareUrl, recordingId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Create record failed';
    sendToBackground('OFFSCREEN_ERROR', { error: msg });
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
        recordingId: string;
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

    case 'OFFSCREEN_SET_MIC_MUTED': {
      const { muted } = message.payload as { muted: boolean };
      setMicMuted(muted);
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
