/**
 * BestQ — Offscreen Document (Manifest V3)
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
import { STORAGE_KEYS, QUALITY_PRESETS } from '@/types';
import { generateId, retryWithBackoff, sleep } from '@/utils';
import { recordingOpfsName, saveBlobToIDB, micBlobKey } from '@/utils/blobStorage';
import {
  startMonitoringCapture,
  stopMonitoringCapture,
  pauseMonitoringCapture,
  flushMonitoringCapture,
  getMonitoringCaptureHealth,
  isMonitoringCaptureActive,
} from './monitoring.capture';
import {
  buildShareUrl,
  API_BASE_URL as REPORTS_URL,
  SSO_TOKEN_URL,
  SSO_AUTH_HEADER,
} from '@/config';

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
// All host/URL values come from @/config (build-time env). See vite.config.ts.

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
let tabAudioStreams: MediaStream[] = []; // audible-tab audio mixed into desktop recordings
let webcamStream: MediaStream | null = null;
let audioContext: AudioContext | null = null; // mixes system/tab audio into one track
let audioLimiter: DynamicsCompressorNode | null = null; // master bus tab-audio sources feed into
// The mic records to its OWN blob, parallel to the main recording, so the editor can
// mute mic and system audio independently (they can't be separated once summed).
let micRecorder: MediaRecorder | null = null;
let micChunks: Blob[] = [];
let sink: RecordingSink | null = null; // streams recorder chunks to disk (OPFS) or memory
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

// ─── Recording Sink (stream-to-disk) ───────────────────────────────────────────
// MediaRecorder emits a Blob every timeslice. Buffering them all in a JS array
// for the whole recording (the old approach) makes multi-hour captures balloon
// memory and eventually crash the offscreen document. Instead we stream each
// chunk straight to a file in the Origin Private File System (OPFS) — disk-backed
// and shared across extension pages, so the editor can read it back without ever
// holding the whole recording in RAM. Falls back to in-memory if OPFS is
// unavailable (recording still works, just bounded by memory as before).

interface RecordingSink {
  /** Storage backing — the editor decides whether to also fall back to IDB. */
  readonly kind: 'opfs' | 'memory';
  /** Enqueue a chunk. Fire-and-forget; writes are serialized internally. */
  write(chunk: Blob): void;
  /** Flush all pending writes and return the full recording as a Blob. */
  finalize(): Promise<Blob>;
  /** Best-effort salvage after finalize() failed: whatever did get stored, with no
   *  further writing or closing. Never throws — returns an empty Blob at worst. */
  recover(): Promise<Blob>;
  /** Abandon the recording and free any partial data (on error paths). */
  discard(): Promise<void>;
}

async function createRecordingSink(recordingId: string, mime: string): Promise<RecordingSink> {
  try {
    const root = await navigator.storage.getDirectory();
    const name = recordingOpfsName(recordingId);
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();

    // Chain writes so overlapping timeslices can't interleave (a single 4K frame
    // can take >1s to flush). Any write failure latches `failed` and is surfaced
    // at finalize() rather than crashing the dataavailable handler.
    let queue: Promise<void> = Promise.resolve();
    let failed: unknown = null;

    return {
      kind: 'opfs',
      write(chunk) {
        queue = queue
          .then(() => writable.write(chunk))
          .catch((err) => {
            failed ??= err;
            console.error('[Offscreen] OPFS chunk write failed:', err);
          });
      },
      async finalize() {
        await queue;
        await writable.close();
        if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
        const file = await handle.getFile();
        // Re-tag with the recorder's MIME type (OPFS files have no media type).
        return file.slice(0, file.size, mime);
      },
      async recover() {
        // Read the file back without touching the writable again — it may be the
        // very thing that failed. Everything written before the failure is intact
        // and, WebM being a streaming container, plays up to that point.
        try {
          const file = await handle.getFile();
          return file.slice(0, file.size, mime);
        } catch (err) {
          console.error('[Offscreen] OPFS recovery failed:', err);
          return new Blob([], { type: mime });
        }
      },
      async discard() {
        try {
          await queue;
          await writable.close();
        } catch {
          /* ignore */
        }
        try {
          await root.removeEntry(name);
        } catch {
          /* ignore */
        }
      },
    };
  } catch (err) {
    console.warn('[Offscreen] OPFS unavailable — buffering recording in memory:', err);
    const mem: Blob[] = [];
    return {
      kind: 'memory',
      write(chunk) {
        mem.push(chunk);
      },
      finalize() {
        return Promise.resolve(new Blob(mem, { type: mime }));
      },
      recover() {
        return Promise.resolve(new Blob(mem, { type: mime }));
      },
      discard() {
        mem.length = 0;
        return Promise.resolve();
      },
    };
  }
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
  const preset = QUALITY_PRESETS[options.quality] ?? QUALITY_PRESETS['720p'];

  if (options.type === 'screen') {
    return navigator.mediaDevices.getDisplayMedia({
      // No displaySurface hint → the picker offers Chrome Tab / Window / Entire
      // Screen equally. Picking a Tab captures that tab's audio on every OS;
      // Entire-Screen system audio works on Windows/ChromeOS (macOS has no
      // system-loopback driver, so screen/window audio can't be captured there).
      //
      // Frame rate is the biggest lever on file size for screen content: the
      // capture track is constrained here (MediaRecorder only encodes the frames
      // the track produces), so a low preset fps directly shrinks the output.
      video: {
        frameRate: { ideal: preset.frameRate, max: preset.frameRate },
        width: { ideal: preset.width },
        height: { ideal: preset.height },
      },
      // Capture system/computer audio (meeting voices, media playback) only when
      // the user enabled it. The browser still shows a "Share audio" checkbox in
      // the picker that the user must also confirm.
      audio: options.systemAudio ? { suppressLocalAudioPlayback: false } : false,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: options.systemAudio ? 'include' : 'exclude',
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
        // Cap resolution/frame rate to the quality preset so tab recordings get
        // the same size reduction as screen shares.
        maxWidth: preset.width,
        maxHeight: preset.height,
        maxFrameRate: preset.frameRate,
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
// Captured system/tab audio comes in well below mic level, so boost it.
// A limiter after the gain prevents the boosted loud passages from clipping.
const SYSTEM_AUDIO_GAIN = 3.0;

/**
 * Capture a tab's audio via its tab-capture stream id. Used to fold meeting
 * audio into a desktop recording when getDisplayMedia can't provide system
 * audio (e.g. macOS screen/window shares have no system-loopback driver).
 */
async function acquireTabAudio(streamId: string): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as any,
      video: false,
    });
  } catch (err) {
    console.warn('[Offscreen] Could not capture tab audio for desktop recording:', err);
    return null;
  }
}

// Whether this recording expects tab audio to be streamed in mid-recording by the
// background (screen/window share on a platform where getDisplayMedia gives no
// audio). Read by the OFFSCREEN_START_RECORDING handler to tell the background
// whether to drive the live per-tab capture.
let needsDynamicTabAudio = false;

async function createRecordingStream(
  options: RecordingOptions,
  streamId?: string,
): Promise<MediaStream> {
  captureStream = await acquireCaptureStream(options, streamId);
  micStream = await acquireMicStream(options);

  const videoTrack = captureStream.getVideoTracks()[0];
  const captureAudioTracks = captureStream.getAudioTracks();

  const hasCaptureAudio = captureAudioTracks.length > 0;

  // For screen/window shares with system audio enabled, when getDisplayMedia
  // itself produced no audio track (always the case on macOS), the recording's
  // audio comes from per-tab captures the background streams in live via
  // OFFSCREEN_ADD_TAB_AUDIO as tabs across the selected window/browser start
  // playing. Build the persistent mixing graph now — even with no sources yet —
  // so those tabs can be folded in mid-recording and the audio follows the scope.
  needsDynamicTabAudio = options.type === 'screen' && options.systemAudio && !hasCaptureAudio;

  const tracks: MediaStreamTrack[] = [];
  if (videoTrack) tracks.push(videoTrack);

  // NOTE: the mic is deliberately NOT mixed into this stream. It is recorded to its
  // own blob by `startMicRecorder`, so the editor can mute mic and system audio
  // independently. Summing them here would fuse them into one track and make that
  // impossible after the fact — which is exactly the bug this split fixes.

  // No system audio to mix and none coming later → record the capture stream as-is.
  if (!hasCaptureAudio && !needsDynamicTabAudio) {
    return videoTrack ? new MediaStream(tracks) : captureStream;
  }

  // Build a persistent Web Audio graph: every audio source (capture audio, mic,
  // and any tabs added later) is boosted into a shared master limiter that feeds
  // the recorded destination track, so the summed audio never clips.
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  const limiter = audioContext.createDynamicsCompressor();
  limiter.threshold.value = -3; // dB — start limiting just below clipping
  limiter.knee.value = 0;
  limiter.ratio.value = 20; // hard limit
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(destination);
  audioLimiter = limiter; // dynamically-added tabs connect here

  // Capture audio present → tab recording (chromeMediaSource:'tab') or
  // getDisplayMedia system audio (Windows/ChromeOS). Tab capture mutes the tab's
  // local playback so echo it back; getDisplayMedia system audio does not mute,
  // so don't monitor it (that would double the sound).
  const monitorCaptureAudio = options.type === 'tab';
  for (const track of captureAudioTracks) {
    const src = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    gain.gain.value = SYSTEM_AUDIO_GAIN;
    src.connect(gain).connect(limiter);
    if (monitorCaptureAudio) src.connect(audioContext.destination);
  }

  // Mic intentionally omitted from this graph — see the note above; it goes to its
  // own recorder so it stays independently mutable in the editor.

  // The offscreen document has no user gesture, so the AudioContext starts
  // suspended and the graph outputs silence. With a mic, getUserMedia happens
  // to resume it — which is why system audio previously only recorded when the
  // mic was on. Resume explicitly so system audio is captured independently.
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (err) {
      console.warn('[Offscreen] Could not resume AudioContext:', err);
    }
  }

  tracks.push(...destination.stream.getAudioTracks());
  return new MediaStream(tracks);
}

/**
 * Fold a captured tab's audio into the live recording graph. Called mid-recording
 * by the background as tabs within the recording scope (the selected window, or the
 * whole browser for entire-screen) start producing sound — so the recorded audio
 * follows the selected surface rather than only the tab recording started on.
 * No-op if the mixing graph wasn't built (e.g. system audio disabled).
 */
async function addTabAudioSource(streamId: string): Promise<void> {
  if (!audioContext || !audioLimiter) return;
  const s = await acquireTabAudio(streamId);
  if (!s) return;
  tabAudioStreams.push(s);
  for (const track of s.getAudioTracks()) {
    const src = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    gain.gain.value = SYSTEM_AUDIO_GAIN;
    src.connect(gain).connect(audioLimiter);
    // Tab capture mutes the tab's local playback — echo it back so the user still
    // hears it while recording.
    src.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch {
      /* ignore */
    }
  }
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

  const { options, streamId, recordingId } = payload;

  mimeType = getSupportedMimeType();
  const preset = QUALITY_PRESETS[options.quality] ?? QUALITY_PRESETS['720p'];
  isRecordingActive = true;

  stream = await createRecordingStream(options, streamId);

  // Stream chunks straight to disk so multi-hour recordings don't exhaust memory.
  sink = await createRecordingSink(recordingId, mimeType);

  recorder = new MediaRecorder(stream, {
    // Honor the negotiated MIME type instead of hardcoding vp9 (which throws on
    // browsers without VP9 encode support), and drive bitrate from the preset.
    mimeType,
    videoBitsPerSecond: preset.videoBitrate,
    audioBitsPerSecond: preset.audioBitrate,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) sink?.write(e.data);
  };

  recorder.onerror = (e) => {
    console.error('[Offscreen] MediaRecorder error:', e.error);
    sendToBackground('OFFSCREEN_ERROR', { error: e.error?.message ?? 'MediaRecorder error' });
  };

  // 1-second timeslices for consistent chunking
  recorder.start(1000);

  startMicRecorder();
  watchForCaptureEnd();
}

/**
 * Finish the recording when the captured surface goes away on its own.
 *
 * A screen/window share can end without any involvement from our UI: the browser
 * renders its OWN "Stop sharing" bar for getDisplayMedia and the user clicks that,
 * or the shared window is closed, or the display is disconnected. The video track
 * fires `ended`, and until now nothing listened for it — so the extension carried
 * on believing it was recording. The floating toolbar kept counting up over a dead
 * stream, and whatever the user did next (waiting, then pressing our Stop) produced
 * a file that ended whenever the track had actually died. This is the single most
 * likely way a recording "doesn't record" or comes back short.
 *
 * A capture that has ended is a stop, so treat it as one: hand it to the background,
 * which runs the normal teardown and saves everything captured up to that point.
 */
function watchForCaptureEnd(): void {
  const tracks = captureStream?.getTracks() ?? [];
  for (const track of tracks) {
    // Audio-only tracks ending is not fatal (a tab going silent, a mixed source
    // dropping out) — only the video surface disappearing ends the recording.
    if (track.kind !== 'video') continue;
    track.addEventListener('ended', () => {
      if (!isRecordingActive) return;
      console.warn('[Offscreen] Captured surface ended — finalizing recording');
      sendToBackground('OFFSCREEN_CAPTURE_ENDED');
    });
  }
}

/**
 * Record the microphone to its own blob, in parallel with the main recording.
 *
 * Both recorders are started back-to-back off the same live streams, so the two
 * files line up on playback. Keeping them separate is what lets the editor offer
 * independent "mute mic" and "mute system audio" — mixing at record time would
 * collapse them into one inseparable track.
 */
function startMicRecorder(): void {
  micChunks = [];
  micRecorder = null;

  const micTracks = micStream?.getAudioTracks() ?? [];
  if (micTracks.length === 0) return;

  try {
    const micOnly = new MediaStream(micTracks);
    const preferred = ['audio/webm;codecs=opus', 'audio/webm'];
    const micMime = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    micRecorder = new MediaRecorder(micOnly, micMime ? { mimeType: micMime } : undefined);
    micRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) micChunks.push(e.data);
    };
    micRecorder.onerror = (e) => {
      // Non-fatal: the main recording continues; the mic track is simply absent.
      console.warn('[Offscreen] Mic recorder error:', e.error);
    };
    micRecorder.start(1000);
  } catch (err) {
    console.warn('[Offscreen] Could not start mic recorder:', err);
    micRecorder = null;
  }
}

/** Stop the mic recorder and return its blob (null when no mic was recorded). */
async function finalizeMicRecording(): Promise<Blob | null> {
  const rec = micRecorder;
  if (!rec) return null;
  try {
    if (rec.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
    }
    if (micChunks.length === 0) return null;
    return new Blob(micChunks, { type: rec.mimeType || 'audio/webm' });
  } catch (err) {
    console.warn('[Offscreen] Could not finalize mic recording:', err);
    return null;
  } finally {
    micRecorder = null;
    micChunks = [];
  }
}

function pauseRecording(): void {
  if (recorder?.state === 'recording') {
    recorder.pause();
  }
  // Keep the mic track in lockstep, or the two files drift out of sync.
  if (micRecorder?.state === 'recording') {
    micRecorder.pause();
  }
}

function resumeRecording(): void {
  if (recorder?.state === 'paused') {
    recorder.resume();
  }
  if (micRecorder?.state === 'paused') {
    micRecorder.resume();
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
  const activeRecorder = recorder;

  // Stopping fires a final `dataavailable` (flushed into the sink) before `stop`.
  //
  // Bounded, because this await used to be the last place a recording could vanish:
  // `onstop` not arriving — a recorder wedged on a stream whose source already died,
  // which is the common case on a long screen share — hung the stop forever. The
  // toolbar stayed up, nothing was written out, and the user's only way out was to
  // kill the browser, taking the recording with it. Every timeslice up to this point
  // is already in the sink, so timing out and finalizing what we have is strictly
  // better than waiting indefinitely for a callback that isn't coming.
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeout = setTimeout(() => {
      console.warn('[Offscreen] MediaRecorder.onstop timed out — finalizing what was captured');
      done();
    }, 10_000);
    const finish = (): void => {
      clearTimeout(timeout);
      done();
    };
    activeRecorder.onstop = finish;
    activeRecorder.onerror = (e) => {
      // Not a rejection: an error on stop still leaves everything already written
      // to the sink perfectly recoverable.
      console.error('[Offscreen] MediaRecorder error while stopping:', e.error);
      finish();
    };
    if (activeRecorder.state !== 'inactive') {
      try {
        activeRecorder.stop();
      } catch (err) {
        console.error('[Offscreen] MediaRecorder.stop() threw:', err);
        finish();
      }
    } else {
      finish();
    }
  });

  // Grab the parallel mic track before cleanup() tears the streams down.
  const micBlob = await finalizeMicRecording();

  const activeSink = sink;
  let finalBlob: Blob;
  try {
    finalBlob = await (activeSink?.finalize() ?? Promise.resolve(new Blob([], { type: mimeType })));
  } catch (err) {
    // A chunk write failed somewhere in the recording. WebM is a streaming
    // container, so what did land on disk is still playable up to that point —
    // returning it beats discarding an hour of video over one bad write.
    console.error('[Offscreen] Sink finalize failed — recovering partial recording:', err);
    finalBlob = (await activeSink?.recover()) ?? new Blob([], { type: mimeType });
  }

  cleanup();

  // Generate thumbnail and open the panel immediately so the user sees something
  const thumbnailDataUrl = await generateThumbnail(finalBlob);
  lastThumbnailDataUrl = thumbnailDataUrl;

  // OPFS-backed recordings are already on disk (the editor reads them directly by
  // name); only the in-memory fallback needs copying into IDB for the editor.
  if (activeSink?.kind !== 'opfs') {
    try {
      await saveBlobToIDB(metadata.recordingId, finalBlob);
    } catch (err) {
      console.warn('[Offscreen] Could not save blob to IDB:', err);
    }
  }

  // Persist the mic track under a sibling key so the editor can load it alongside
  // the video and toggle it independently. Failing here is non-fatal: the editor
  // simply finds no mic track and offers only the system-audio control.
  if (micBlob && micBlob.size > 0) {
    try {
      await saveBlobToIDB(micBlobKey(metadata.recordingId), micBlob);
    } catch (err) {
      console.warn('[Offscreen] Could not save mic blob to IDB:', err);
    }
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
    const width = Math.min(video.videoWidth || 1280, 640);
    const height = Math.round(width * (video.videoHeight / (video.videoWidth || 1)));
    canvas.width = width;
    canvas.height = height || 360;
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);

    URL.revokeObjectURL(objectUrl);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

/** Upload a thumbnail data URL as a JPEG file and return its URL. Falls back
 *  to the original data URL if the upload fails, so the record never loses
 *  its preview. NOTE: the files GET endpoint requires a Bearer token, so the
 *  portal must fetch this URL with auth (a plain <img src> gets a 401). */
async function uploadThumbnail(
  dataUrl: string,
  project: string,
  token: string,
  ts: number,
): Promise<string> {
  try {
    const thumbBlob = await (await fetch(dataUrl)).blob();
    const thumbFile = new File([thumbBlob], `thumb-${ts}.jpg`, { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('file', thumbFile);
    const res = await fetch(`${REPORTS_URL}/v1/${project}/files/upload`, {
      method: 'POST',
      headers: { ...authHeaders(token), Accept: 'text/plain, application/json, */*' },
      body: formData,
    });
    if (res.ok) {
      const fileName = (await res.text()).trim();
      if (fileName) return `${REPORTS_URL}/v1/${project}/files/${fileName}`;
    }
  } catch {
    /* fall through to data URL */
  }
  return dataUrl;
}

function cleanup(): void {
  stream?.getTracks().forEach((t) => t.stop());
  captureStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  tabAudioStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  webcamStream?.getTracks().forEach((t) => t.stop());
  if (audioContext && audioContext.state !== 'closed') {
    void audioContext.close();
  }

  stream = null;
  captureStream = null;
  micStream = null;
  tabAudioStreams = [];
  webcamStream = null;
  audioContext = null;
  audioLimiter = null;
  needsDynamicTabAudio = false;
  recorder = null;
  sink = null;
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
      quality: '720p',
      hasAudio: false,
      hasWebcam: false,
    });
  } finally {
    captureStream?.getTracks().forEach((t) => t.stop());
  }
}

// ─── Upload (runs entirely in offscreen — no blob transfer needed) ─────────────

interface UploadMetadata {
  title: string;
  /** User-provided description; capped at 125 chars before upload. */
  description?: string;
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
      description: metadata.description?.trim().slice(0, 125) || 'Recording captured with BestQ',
      type: 'video',
      mimeType: metadata.mimeType.split(';')[0],
      status: 'completed',
      projectId: '1',
      shareId: `share-${ts}`,
      isPublic: false,
      allowDownload: true,
      viewCount: 0,
      url: fileUrl,
      size: blob.size,
      duration: Math.round(metadata.duration ?? 0),
      metadata: JSON.stringify({
        browser: 'chrome',
        source: (metadata.type ?? 'tab').toLowerCase(),
      }),
      createdAt: isoNow,
      updatedAt: isoNow,
    };
    if (lastThumbnailDataUrl) {
      createBody['thumbnailUrl'] = await uploadThumbnail(lastThumbnailDataUrl, project, token, ts);
    }

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

    const shareUrl = buildShareUrl(project, recordingId);
    sendToBackground('OFFSCREEN_UPLOAD_COMPLETE', { shareUrl, recordingId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Create record failed';
    sendToBackground('OFFSCREEN_ERROR', { error: msg });
  }
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
        .then(() =>
          sendResponse({
            success: true,
            // Tell the background what surface was picked and whether it needs to
            // drive live per-tab audio capture across the recording scope.
            displaySurface: captureStream?.getVideoTracks()[0]?.getSettings().displaySurface,
            needsTabAudio: needsDynamicTabAudio,
          }),
        )
        .catch((err: Error) => {
          cleanup();
          sendResponse({ error: err.message });
        });
      return true;
    }

    case 'OFFSCREEN_ADD_TAB_AUDIO': {
      const { streamId } = message.payload as { streamId: string };
      addTabAudioSource(streamId)
        .then(() => sendResponse({ success: true }))
        .catch((err: Error) => sendResponse({ error: err.message }));
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

    // ── Screen monitoring ──────────────────────────────────────────────────
    // Capture lives in this document because a service worker has no canvas and
    // no getDisplayMedia, and because holding the stream here is what keeps it
    // alive across the worker's constant teardowns.
    case 'OFFSCREEN_MONITORING_START_CAPTURE': {
      const payload = message.payload as {
        project: string;
        sessionId: string;
        intervalSeconds: 30 | 60;
        streamId: string;
      };
      startMonitoringCapture(payload)
        .then((result) => sendResponse(result))
        .catch((err: Error) =>
          sendResponse({
            started: false,
            error: err.message,
            health: getMonitoringCaptureHealth(),
          }),
        );
      return true;
    }

    case 'OFFSCREEN_MONITORING_STOP_CAPTURE': {
      stopMonitoringCapture();
      sendResponse({ success: true });
      return false;
    }

    case 'OFFSCREEN_MONITORING_PAUSE_CAPTURE': {
      // Releases the stream but leaves the queue draining — frames already
      // captured are still valid and must still be uploaded.
      pauseMonitoringCapture();
      sendResponse({ success: true });
      return false;
    }

    case 'OFFSCREEN_MONITORING_FLUSH': {
      flushMonitoringCapture()
        .then(() => sendResponse({ success: true }))
        .catch((err: Error) => sendResponse({ error: err.message }));
      return true;
    }

    case 'OFFSCREEN_MONITORING_HEALTH_QUERY': {
      // The background's watchdog. Returns the explicit capture state plus a
      // live read of the video track — never "is there a timer object", which
      // answers neither whether the stream is alive nor whether frames are
      // being taken.
      sendResponse({ health: getMonitoringCaptureHealth(), active: isMonitoringCaptureActive() });
      return false;
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
