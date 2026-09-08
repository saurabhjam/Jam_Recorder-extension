/**
 * Screen monitoring — capture control, in the service worker.
 *
 * ── Why capture is not in the browser any more ───────────────────────────────
 * It used to open a stream with `getDisplayMedia` from the offscreen document.
 * That always shows Chrome's share picker, and the picker offers **Chrome tab**
 * and **Window** beside **Entire screen**. No extension API can remove those
 * choices — `displaySurface: 'monitor'` only preselects a tab, which Chrome
 * demonstrably ignores when composing the dialog — so a monitoring session
 * could be pointed at a single tab, and every screenshot in the report would
 * then be a partial record of what the person was actually doing. Post-hoc
 * rejection made that safe but not pleasant: the user still had to choose, and
 * choosing wrong meant starting over.
 *
 * `chrome.desktopCapture` could not replace it either: from a service worker it
 * demands a target tab, and a target tab scopes the stream to that tab's
 * frames — which excludes the offscreen document that would have to open it.
 *
 * So the frames come from the desktop agent, which reads the display directly.
 * There is no picker, no prompt, and no window or region entry point in its
 * protocol — the capability that allowed the wrong thing is simply absent.
 *
 * ── What this module now owns ────────────────────────────────────────────────
 * The capture *state* and the *watchdog*. Frames arrive as `SCREEN_FRAME`
 * messages handled in native-agent.manager.ts, which reports each one here.
 *
 * Recording is untouched and still uses `getDisplayMedia` in the offscreen
 * document, where choosing a tab or a window is exactly what the user wants.
 *
 * ── Why the watchdog cannot trust a timer ────────────────────────────────────
 * The old health check was `Boolean(stream && timer)`, which answered neither
 * "is capture alive" nor "are frames arriving". Health is now the agent's
 * reported capability plus the age of the last frame actually received, and a
 * stale `lastSuccessfulCaptureAt` is a failure even when everything claims to
 * be fine.
 */

import {
  INITIAL_CAPTURE_HEALTH,
  type CaptureHealth,
  type MonitoringInterval,
} from '@/types/monitoring';

let health: CaptureHealth = { ...INITIAL_CAPTURE_HEALTH };

export function getCaptureHealth(): CaptureHealth {
  return health;
}

export function setCaptureHealth(next: CaptureHealth): void {
  health = next;
}

export function resetCaptureHealth(): void {
  health = { ...INITIAL_CAPTURE_HEALTH };
}

/** What the agent must report before a session may start capturing. */
export interface AgentCaptureReadiness {
  connected: boolean;
  /** The agent's own answer to "can I read the whole screen". */
  screenCapture: boolean;
  /** True when the OS grant is the thing that is missing. */
  permissionMissing: boolean;
  /** Platform cannot do it at all (Wayland, macOS below 14). */
  unsupported: boolean;
}

/**
 * Begin capture, or refuse.
 *
 * Refusing is the point. Monitoring means the entire screen, so when the agent
 * cannot deliver that, the session must say so rather than degrade to
 * something narrower — there is deliberately no browser fallback left to
 * degrade to.
 *
 * The cadence is not started here: it is passed to the agent with the session
 * (`screenshotIntervalSeconds`) and runs on its native timer, because a
 * service worker is torn down every thirty seconds and an offscreen document is
 * throttled while the browser is in the background — which, for a tool that
 * watches what someone does in *other* applications, is most of the time.
 */
export function startCapture(
  readiness: AgentCaptureReadiness,
  _interval: MonitoringInterval,
): {
  started: boolean;
  health: CaptureHealth;
} {
  if (!readiness.connected) {
    health = {
      ...INITIAL_CAPTURE_HEALTH,
      status: 'failed',
      error:
        'The BestQ monitoring agent is not running, so the screen cannot be captured. Install it and restart your browser.',
    };
    return { started: false, health };
  }
  if (readiness.permissionMissing) {
    health = {
      ...INITIAL_CAPTURE_HEALTH,
      status: 'failed',
      error:
        'Screen Recording permission is required. Grant it to the BestQ agent in System Settings › Privacy & Security › Screen Recording, then start again.',
    };
    return { started: false, health };
  }
  if (readiness.unsupported) {
    health = {
      ...INITIAL_CAPTURE_HEALTH,
      status: 'failed',
      error: 'Whole-screen capture is not available on this operating system.',
    };
    return { started: false, health };
  }
  if (!readiness.screenCapture) {
    health = {
      ...INITIAL_CAPTURE_HEALTH,
      status: 'failed',
      error: 'The monitoring agent cannot capture this screen.',
    };
    return { started: false, health };
  }

  health = {
    ...INITIAL_CAPTURE_HEALTH,
    status: 'active',
    // The agent reads the display directly, so there is no MediaStreamTrack to
    // be live or dead. Frame arrival is the only honest liveness signal, and
    // the watchdog below uses exactly that.
    trackLive: true,
    error: null,
  };
  return { started: true, health };
}

/** Record a frame the agent delivered. */
export function noteFrameCaptured(capturedAt: string): CaptureHealth {
  health = {
    ...health,
    status: 'active',
    trackLive: true,
    lastCaptureAttemptAt: capturedAt,
    lastSuccessfulCaptureAt: capturedAt,
    successfulCaptureCount: health.successfulCaptureCount + 1,
    error: null,
  };
  return health;
}

/**
 * Record a capture the agent could not take.
 *
 * `reconnect` rather than `failed` for a transient read failure: the session
 * keeps its time, activity and inactivity, and the next interval may well
 * succeed. A permission or platform problem is `failed`, because nothing will
 * change until someone acts.
 */
export function noteFrameFailed(reason: string, permanent: boolean): CaptureHealth {
  health = {
    ...health,
    status: permanent ? 'failed' : 'reconnect',
    trackLive: false,
    failedCaptureCount: health.failedCaptureCount + 1,
    error: reason,
  };
  return health;
}

export function stopCapture(): void {
  resetCaptureHealth();
}

/**
 * How long a session may go without a frame before it is called broken.
 *
 * Two intervals plus a minute of slack: one missed capture can happen for
 * innocent reasons — a slow encode, a machine under load — but two in a row
 * means something is actually wrong and the user needs to be told rather than
 * shown a reassuring "Monitoring Active".
 */
export function isCaptureStale(intervalSeconds: number, now = Date.now()): boolean {
  if (health.status !== 'active' && health.status !== 'capturing') return false;
  const last = health.lastSuccessfulCaptureAt
    ? new Date(health.lastSuccessfulCaptureAt).getTime()
    : null;
  if (last == null) return false;
  return now - last > intervalSeconds * 2000 + 60_000;
}

/** Does capture need someone to act before it can continue? */
export function needsReconnect(): boolean {
  return health.status === 'reconnect' || health.status === 'failed';
}
