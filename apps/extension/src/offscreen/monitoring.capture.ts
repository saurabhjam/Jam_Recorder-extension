/**
 * Screen monitoring — frame capture and upload, in the offscreen document.
 *
 * ── Why the stream is acquired here, with getDisplayMedia ───────────────────
 * `chrome.desktopCapture.chooseDesktopMedia` cannot be made to work for this.
 * Called from the service worker it refuses outright — "a target tab is
 * required when called from a service worker context" — and supplying a target
 * tab scopes the resulting stream to that tab ("the stream can only be used by
 * frames in the given tab whose security origin matches tab.url"), which the
 * offscreen document is not. The two requirements are mutually exclusive.
 *
 * `getDisplayMedia` from this document is the path the recording feature has
 * always used successfully, so it is the one monitoring uses too.
 *
 * Entire-screen-only is then enforced by INSPECTION rather than by restricting
 * the picker: `displaySurface: 'monitor'` biases what the picker offers, and
 * the track's actual `displaySurface` setting is checked afterwards. A user who
 * picks a tab or a window is refused with a clear message. That is a real
 * guarantee; a constraint alone is only a hint.
 *
 * ── Why the scheduler is deadline-based ──────────────────────────────────────
 * `setInterval` plus an in-flight guard silently degrades: a tick that lands
 * while the previous capture is still uploading is dropped, so a 60s interval
 * with a 5s upload produces a screenshot every 60s *only while uploads are
 * fast*. A chain of `setTimeout(…, interval)` scheduled after each upload is
 * worse — it adds the whole capture+upload latency to every gap and drifts
 * permanently. So the schedule is a series of absolute deadlines: 10:00:00,
 * 10:01:00, 10:02:00 … and each capture computes its wait from the next
 * deadline, not from when it finished.
 *
 * ── Why capture and upload are decoupled ─────────────────────────────────────
 * A frame is written to a durable IndexedDB queue the moment it is encoded, and
 * uploaded by a separate drain loop. Capture cadence therefore never depends on
 * network latency, and a failed upload costs a retry rather than a lost
 * screenshot.
 */

import { generateId } from '@/utils';
import { enqueueSnapshot, purgeStaleSessions } from '@/utils/monitoringQueue';
import { advanceDeadline, nextDeadline } from '@/utils/captureSchedule';
import type { CaptureHealth, CaptureStatus, MonitoringInterval } from '@/types/monitoring';
import { INITIAL_CAPTURE_HEALTH } from '@/types/monitoring';

interface CaptureContext {
  project: string;
  sessionId: string;
  intervalSeconds: MonitoringInterval;
}

/** JPEG: a desktop screenshot is photograph-like, and PNG costs 5-10x the bytes
 *  for no visible gain. One of the three types the API accepts. */
const SNAPSHOT_MIME = 'image/jpeg';
const SNAPSHOT_QUALITY = 0.65;

/**
 * Longest edge of a stored capture.
 *
 * 1280 keeps window titles, tab strips and normal application UI legible —
 * which is the entire purpose of the image — while a 4K frame at full
 * resolution would be several megabytes, i.e. gigabytes per user per day.
 */
const MAX_SNAPSHOT_EDGE = 1280;

/** How often the queue drain runs while a session is active. */

let stream: MediaStream | null = null;
let context: CaptureContext | null = null;
let captureTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let draining = false;

/**
 * The next absolute capture time, in epoch ms.
 *
 * This — not a timer handle — is the schedule. Every deadline is derived by
 * advancing it by exactly one interval, so latency cannot shift the cadence.
 */
let nextCaptureAt = 0;

let health: CaptureHealth = { ...INITIAL_CAPTURE_HEALTH };

function setStatus(status: CaptureStatus, error: string | null = null): void {
  health = { ...health, status, error };
  publishHealth();
}

function videoTrack(): MediaStreamTrack | null {
  return stream?.getVideoTracks()[0] ?? null;
}

/** The real track state, read fresh — never inferred from a timer's existence. */
function isTrackLive(): boolean {
  const track = videoTrack();
  return Boolean(track && track.readyState === 'live' && track.enabled);
}

function publishHealth(): void {
  health = { ...health, trackLive: isTrackLive() };
  chrome.runtime
    .sendMessage({
      target: 'background',
      type: 'OFFSCREEN_MONITORING_HEALTH',
      payload: { health, nextCaptureAt: nextCaptureAt || null },
    })
    .catch(() => {
      // The worker is asleep; it re-reads health on its own alarm tick.
    });
}

// ─── Frame grabbing ───────────────────────────────────────────────────────────

/**
 * Grab one frame and scale it down.
 *
 * `ImageCapture.grabFrame` reads the current frame without a playing <video>,
 * so it is tried first; the video path is the fallback for engines that do not
 * expose it (Brave has shipped both ways).
 */
async function grabScaledFrame(): Promise<Blob | null> {
  const track = videoTrack();
  if (!track || track.readyState !== 'live') return null;

  let bitmap: ImageBitmap | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ImageCaptureCtor = (globalThis as any).ImageCapture;
    if (ImageCaptureCtor) {
      const capturer = new ImageCaptureCtor(track);
      bitmap = (await capturer.grabFrame()) as ImageBitmap;
    }
  } catch {
    // Fall through to the video element path.
  }

  if (!bitmap) {
    const video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    video.muted = true;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('frame: video load failed'));
        setTimeout(() => reject(new Error('frame: video load timed out')), 5000);
      });
      await video.play();
      bitmap = await createImageBitmap(video);
    } finally {
      video.pause();
      video.srcObject = null;
    }
  }

  if (!bitmap) return null;

  const scale = Math.min(1, MAX_SNAPSHOT_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: SNAPSHOT_MIME, quality: SNAPSHOT_QUALITY });
}

/**
 * Capture one frame and put it in the queue.
 *
 * Returns without uploading: the drain loop owns that. Enqueueing before any
 * network call is what makes a frame survive a crash between capture and upload.
 */
async function captureAndEnqueue(): Promise<void> {
  if (!context || inFlight) return;
  inFlight = true;
  const attemptAt = new Date().toISOString();
  health = { ...health, lastCaptureAttemptAt: attemptAt };
  setStatus('capturing');

  try {
    if (!isTrackLive()) {
      // The stream died without firing `ended` (a display disconnected, a
      // permission revoked). Reconnection needs a fresh user grant, so the
      // session must say so rather than keep pretending.
      throw new Error('Screen capture stream is no longer live');
    }

    const blob = await grabScaledFrame();
    if (!blob || blob.size === 0) throw new Error('Captured frame was empty');

    await enqueueSnapshot({
      clientSnapshotId: generateId(20),
      sessionId: context.sessionId,
      project: context.project,
      // The moment the frame was grabbed. Never the upload time (§42).
      capturedAt: attemptAt,
      blob,
      mimeType: SNAPSHOT_MIME,
      fileSize: blob.size,
    });

    health = {
      ...health,
      lastSuccessfulCaptureAt: attemptAt,
      successfulCaptureCount: health.successfulCaptureCount + 1,
      error: null,
    };
    setStatus('active');
    // The worker owns uploading. Telling it now keeps a screenshot's latency at
    // the capture interval rather than the sweep interval.
    notify('OFFSCREEN_MONITORING_SNAPSHOT_ENQUEUED');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Capture failed';
    health = { ...health, failedCaptureCount: health.failedCaptureCount + 1 };
    if (!isTrackLive()) {
      stopScheduler();
      setStatus('reconnect', message);
      notify('OFFSCREEN_MONITORING_CAPTURE_LOST', { reason: message });
    } else {
      // The stream is fine, this frame was not. Keep the schedule running.
      setStatus('active', message);
    }
    console.warn('[Monitoring] capture failed:', message);
  } finally {
    inFlight = false;
  }
}

// ─── Deadline scheduler ───────────────────────────────────────────────────────

/**
 * Arm the next capture from the absolute deadline.
 *
 * If deadlines were missed entirely — the machine slept, the document was
 * throttled — the schedule is fast-forwarded to the next future deadline
 * rather than firing a burst of captures for moments that have passed, whose
 * frames would all show the same screen anyway.
 */
function armNext(): void {
  if (!context) return;
  const intervalMs = context.intervalSeconds * 1000;

  // The deadline maths lives in `utils/captureSchedule` so it can be tested
  // without a browser — the no-drift property is the whole point of it.
  const decision = nextDeadline(nextCaptureAt, intervalMs, Date.now());
  nextCaptureAt = decision.nextCaptureAt;
  if (decision.missedDeadlines > 0) {
    health = {
      ...health,
      deferredCaptureCount: health.deferredCaptureCount + decision.missedDeadlines,
    };
    console.warn(
      `[Monitoring] ${decision.missedDeadlines} capture deadline(s) missed (device asleep or throttled)`,
    );
  }
  health = { ...health, nextCaptureAt: new Date(nextCaptureAt).toISOString() };

  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    // Advance the deadline BEFORE capturing, so the next gap is measured from
    // the intended time and never from when this capture happens to finish.
    nextCaptureAt = advanceDeadline(nextCaptureAt, intervalMs);

    if (inFlight) {
      // A capture is still running. Do not start a second one — record the skip
      // and resynchronise, rather than overlapping or drifting.
      health = { ...health, deferredCaptureCount: health.deferredCaptureCount + 1 };
      console.warn('[Monitoring] deadline skipped — previous capture still running');
      armNext();
      return;
    }

    void captureAndEnqueue().finally(() => armNext());
  }, decision.delayMs);

  publishHealth();
}

function stopScheduler(): void {
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
  nextCaptureAt = 0;
  health = { ...health, nextCaptureAt: null };
}

// ─── Uploading lives in the service worker ────────────────────────────────────
//
// Not here. An offscreen document outlives a reload of the extension that
// created it — the page, its timers, its IndexedDB handle and the capture
// stream all keep running, while `chrome.storage` and the other namespaces are
// torn down. Draining from here therefore captured frames perfectly and failed
// every upload on `chrome.storage.local` with "Cannot read properties of
// undefined (reading 'local')", before any request was made. See
// `background/monitoring.uploader.ts`.

function notify(type: string, payload?: unknown): void {
  chrome.runtime.sendMessage({ target: 'background', type, payload }).catch(() => {});
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Prompt for a screen and start capturing.
 *
 * The prompt happens here rather than in the service worker because
 * `chooseDesktopMedia` cannot serve this case at all — see the note at the top
 * of this file. A cancelled prompt is reported as the user's decision, and a
 * chosen tab or window is refused outright: monitoring means a whole screen.
 */
export async function startMonitoringCapture(payload: {
  project: string;
  sessionId: string;
  intervalSeconds: MonitoringInterval;
}): Promise<{ started: boolean; health: CaptureHealth }> {
  stopMonitoringCapture();
  health = { ...INITIAL_CAPTURE_HEALTH };
  setStatus('requesting');
  context = payload;

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        // Biases the picker towards whole screens. A hint, not a guarantee —
        // the user can still choose a tab, which is why the result is checked
        // below rather than trusted.
        displaySurface: 'monitor',
        // Frames are pulled on demand once or twice a minute, so a low rate
        // costs nothing and saves the compositor encoding work nobody reads.
        frameRate: { ideal: 1, max: 5 },
      },
      audio: false,
      // Monitoring never wants the browser's own surface pre-selected, and a
      // mid-session surface switch would silently change what is being
      // recorded without the report showing it.
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  } catch (err) {
    // A cancelled picker throws NotAllowedError, which is the user's decision
    // rather than a fault — named as such so the UI does not cry failure.
    const aborted = err instanceof DOMException && err.name === 'NotAllowedError';
    const message = aborted
      ? 'Screen sharing was cancelled'
      : err instanceof Error
        ? err.message
        : 'Could not open the screen stream';
    context = null;
    setStatus(aborted ? 'idle' : 'failed', message);
    return { started: false, health };
  }

  // Obtaining a stream is not the same as capture being healthy — verify the
  // track before claiming success.
  if (!isTrackLive()) {
    stopMonitoringCapture();
    setStatus('failed', 'The screen stream opened but its video track is not live');
    return { started: false, health };
  }

  // Enforce entire-screen for real.
  //
  // Monitoring means the whole screen; a session that silently captured one tab
  // would make every screenshot in the report a misleading partial record. The
  // picker cannot be restricted from here, so what the user actually chose is
  // read back and anything other than a monitor is refused outright.
  const surface = (videoTrack()?.getSettings() as { displaySurface?: string } | undefined)
    ?.displaySurface;
  if (surface && surface !== 'monitor') {
    stopMonitoringCapture();
    setStatus(
      'failed',
      `Monitoring needs an entire screen, but a ${surface === 'browser' ? 'tab' : surface} was selected. Start again and choose a whole screen.`,
    );
    return { started: false, health };
  }

  // The user can end the share from the browser's own bar, or a display can be
  // unplugged. Either ends monitoring's ability to see anything.
  videoTrack()?.addEventListener('ended', () => {
    stopScheduler();
    setStatus('reconnect', 'Screen sharing was stopped');
    notify('OFFSCREEN_MONITORING_CAPTURE_LOST', { reason: 'stream-ended' });
  });

  // Anything left over from a session that crashed belongs to nothing.
  await purgeStaleSessions(payload.sessionId).catch(() => 0);

  setStatus('active');

  // The initial capture establishes monitoring immediately: a session that
  // starts at 10:00:00 must have a 10:00:00 frame, not its first at 10:01.
  nextCaptureAt = Date.now() + payload.intervalSeconds * 1000;
  await captureAndEnqueue();
  armNext();

  return { started: true, health };
}

export function stopMonitoringCapture(): void {
  stopScheduler();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  context = null;
  inFlight = false;
  setStatus('stopped');
}

/** Pause capture but keep the queue draining — queued frames are still valid. */
export function pauseMonitoringCapture(): void {
  stopScheduler();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  setStatus('idle');
}

/**
 * Flush before the session stops.
 *
 * Runs the drain until the queue stops shrinking, so the last frames of the day
 * are confirmed before the session is settled rather than being abandoned by an
 * abrupt teardown.
 */
export async function flushMonitoringCapture(): Promise<void> {
  // Capture one final frame so the end of a session is represented, then let
  // the worker's flush confirm everything queued. Uploading is not this
  // document's job, and it must not block the stop on work it cannot do.
  if (context && isTrackLive()) {
    await captureAndEnqueue();
    notify('OFFSCREEN_MONITORING_SNAPSHOT_ENQUEUED');
  }
}

/**
 * Real capture health.
 *
 * Explicitly not `Boolean(stream && timer)`: the timer is null while a capture
 * is in flight, and a stream object can outlive its own track. The status plus
 * a live read of the track is the only honest answer.
 */
export function getMonitoringCaptureHealth(): CaptureHealth {
  return { ...health, trackLive: isTrackLive() };
}

/** Is the capture loop genuinely running? */
export function isMonitoringCaptureActive(): boolean {
  return (
    (health.status === 'active' || health.status === 'capturing') &&
    isTrackLive() &&
    context !== null
  );
}
