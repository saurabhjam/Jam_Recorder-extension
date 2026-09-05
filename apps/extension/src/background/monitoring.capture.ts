/**
 * Screen monitoring — capture control, in the service worker.
 *
 * This module owns the *grant* (which screen the user allowed) and the
 * *watchdog*. The frames themselves are grabbed in the offscreen document,
 * which is the only context with a canvas — see offscreen/monitoring.capture.ts.
 *
 * ── Why the grant is acquired here ───────────────────────────────────────────
 * `chrome.desktopCapture.chooseDesktopMedia` is an extension API available only
 * to the service worker. Unlike `getDisplayMedia` it needs no user gesture, and
 * restricting its sources to `['screen']` means the picker offers whole screens
 * and nothing else — which is exactly what monitoring is, as distinct from
 * recording where the user legitimately chooses a tab or a window.
 *
 * ── Why the watchdog cannot trust a timer ────────────────────────────────────
 * The old health check was `Boolean(stream && timer)`. A timer is truthy while
 * the underlying track is dead, and null while a capture is in flight, so it
 * answered neither "is the stream alive" nor "are frames being taken". Health
 * now comes from the offscreen document's explicit capture state plus a live
 * read of the video track, and a stale `lastSuccessfulCaptureAt` is treated as
 * a failure even when everything claims to be fine.
 */

import {
  INITIAL_CAPTURE_HEALTH,
  type CaptureHealth,
  type MonitoringInterval,
} from '@/types/monitoring';

interface OffscreenBridge {
  ensureDocument: () => Promise<void>;
  send: (type: string, payload?: unknown) => Promise<unknown>;
}

let offscreen: OffscreenBridge | null = null;
let health: CaptureHealth = { ...INITIAL_CAPTURE_HEALTH };

export function configureCaptureOffscreen(bridge: OffscreenBridge): void {
  offscreen = bridge;
}

export function getCaptureHealth(): CaptureHealth {
  return health;
}

/** The offscreen document pushes its real state here on every change. */
export function setCaptureHealth(next: CaptureHealth): void {
  health = next;
}

export function resetCaptureHealth(): void {
  health = { ...INITIAL_CAPTURE_HEALTH };
}

/**
 * Ask the offscreen document to acquire the screen and start capturing.
 *
 * The grant itself is taken there, with `getDisplayMedia`, because
 * `chrome.desktopCapture.chooseDesktopMedia` cannot serve this: from a service
 * worker it demands a target tab, and a target tab scopes the stream to that
 * tab's frames — which excludes the offscreen document that has to open it.
 *
 * The document reports back whether the track is genuinely live and whether the
 * user actually picked a whole screen. Obtaining a stream is not the same as
 * capture being healthy, and the two must not be conflated.
 */
export async function startCapture(options: {
  project: string;
  sessionId: string;
  intervalSeconds: MonitoringInterval;
}): Promise<{ started: boolean; health: CaptureHealth }> {
  if (!offscreen) return { started: false, health };
  await offscreen.ensureDocument();
  const result = (await offscreen.send('OFFSCREEN_MONITORING_START_CAPTURE', options)) as
    | { started?: boolean; health?: CaptureHealth; error?: string }
    | undefined;

  if (result?.health) health = result.health;
  if (result?.error) {
    health = { ...health, status: 'failed', error: result.error };
  }
  return { started: result?.started === true, health };
}

export async function stopCapture(): Promise<void> {
  try {
    await offscreen?.send('OFFSCREEN_MONITORING_STOP_CAPTURE');
  } catch {
    // The document is already gone, which is the same outcome.
  }
  resetCaptureHealth();
}

export async function pauseCapture(): Promise<void> {
  try {
    await offscreen?.send('OFFSCREEN_MONITORING_PAUSE_CAPTURE');
  } catch {
    /* nothing to pause */
  }
}

/**
 * Finish outstanding uploads before the session is settled.
 *
 * Bounded inside the offscreen document, so a dead network cannot hold Stop
 * open indefinitely — the queue survives either way.
 */
export async function flushCapture(): Promise<void> {
  try {
    await offscreen?.send('OFFSCREEN_MONITORING_FLUSH');
  } catch {
    /* the document is gone; queued frames remain in IndexedDB */
  }
}

/**
 * Ask the offscreen document for its real capture state.
 *
 * Returns null when the document is unreachable, which is itself meaningful:
 * the document holding the stream no longer exists, so capture is definitely
 * not happening regardless of what the last known health said.
 */
export async function probeCapture(): Promise<CaptureHealth | null> {
  try {
    const result = (await offscreen?.send('OFFSCREEN_MONITORING_HEALTH_QUERY')) as
      | { health?: CaptureHealth }
      | undefined;
    if (result?.health) {
      health = result.health;
      return health;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * How long a session may go without a successful capture before it is called
 * broken.
 *
 * Two intervals plus a minute of slack: one missed deadline can happen for
 * innocent reasons (a slow frame, a deferred deadline), but two in a row means
 * something is actually wrong and the user needs to be told rather than shown
 * a reassuring "Monitoring Active".
 */
export function isCaptureStale(intervalSeconds: number, now = Date.now()): boolean {
  if (health.status !== 'active' && health.status !== 'capturing') return false;
  const last = health.lastSuccessfulCaptureAt
    ? new Date(health.lastSuccessfulCaptureAt).getTime()
    : null;
  if (last == null) return false;
  return now - last > intervalSeconds * 2000 + 60_000;
}

/** Does capture need a fresh grant from the user to continue? */
export function needsReconnect(): boolean {
  return health.status === 'reconnect' || health.status === 'failed';
}
