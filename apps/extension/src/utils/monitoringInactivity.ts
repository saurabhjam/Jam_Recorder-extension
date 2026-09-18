/**
 * Inactivity — every decision about opening and closing an inactive period,
 * with no I/O.
 *
 * ── The failure this module exists to make impossible ────────────────────────
 * A report showed a person inactive for an entire session while their
 * screenshots changed every thirty seconds. The server only counts a period
 * once it is closed, and closes any period still open at the session's end, so
 * ONE lost "idle ended" signal turned everything after it into inactive time.
 * It was lost in several independent ways:
 *
 *  - the agent process restarted (after a sleep, an extension update, a crash)
 *    and the new process never knew a period was open, so never ended it;
 *  - `chrome.idle` opened a period while the agent was momentarily
 *    disconnected, and once the agent was back, `chrome.idle`'s "active" was
 *    ignored because the agent "owned" detection — and the agent had never
 *    seen the period;
 *  - the `chrome.idle` listener was registered asynchronously, so an "active"
 *    event that woke the service worker could be dispatched before it existed.
 *
 * Patching each path would leave the next one. So the rule is structural:
 * events are only hints, and the operating system's own idle counter is
 * consulted every minute (`reconcileInactivity`). A period cannot stay open
 * while the machine reports recent input, whatever happened to the events —
 * and a period the events failed to open is opened from the same evidence.
 *
 * ── When sources disagree, activity wins ─────────────────────────────────────
 * Every ambiguity resolves toward "the person was active": the earliest
 * possible end, the latest possible start. Under-reporting a minute of idleness
 * is a rounding error; reporting a working person as idle is an accusation.
 *
 * Tested in test/monitoringInactivity.test.mjs.
 */

export const INACTIVITY_POLICY = {
  /** Continuous inactivity after which monitoring stops itself. */
  AUTO_STOP_AFTER_MS: 60 * 60_000,

  /**
   * Intervals asked of `chrome.idle.queryState`. Each answer says whether input
   * happened within that many seconds, so together they bracket the time since
   * the last input. The threshold and the auto-stop limit are added at runtime.
   * 15 is the floor `chrome.idle` accepts.
   */
  PROBE_LADDER_SECONDS: [15, 30, 60, 120, 300, 600, 900, 1800, 3600],

  /**
   * Allowance when the agent reports idleness at the moment the threshold is
   * crossed. The agent samples every few seconds and `chrome.idle` rounds its
   * own way, so at the crossing the OS may still read a few seconds short.
   */
  CONFIRM_SLACK_SECONDS: 20,

  /**
   * How long the device may be offline before monitoring stops itself. Long
   * enough for a Wi-Fi ↔ hotspot switch; short enough that losing the network
   * ends the session within a minute or two, as intended.
   */
  NETWORK_LOSS_GRACE_MS: 60_000,
} as const;

export type OsIdleState = 'active' | 'idle' | 'locked';

/** Seconds since the last input, bracketed. `maxSeconds` null means "at least minSeconds, no upper bound known". */
export interface IdleBounds {
  minSeconds: number;
  maxSeconds: number | null;
}

/** The inactive period this client believes is open, and where it came from. */
export interface InactivityTracker {
  /** Start of the period queued to the server, or null when none is open. */
  openSince: string | null;
  /** The agent said idle but the OS did not yet agree; opened once it does. */
  pendingSince: string | null;
  /**
   * The earliest instant inactivity may be attributed to: the session start,
   * or the resume after a pause. Idleness before then was not monitored time.
   */
  notBefore: string | null;
}

export type InactivityCommand = { kind: 'open'; at: string } | { kind: 'close'; at: string };

export interface InactivityDecision {
  tracker: InactivityTracker;
  commands: InactivityCommand[];
  /** Why, when something non-obvious happened. For logs. */
  reason?: string;
}

// ─── Reading the OS ───────────────────────────────────────────────────────────

/** The intervals to probe for a given threshold and auto-stop limit. */
export function probeLadder(thresholdSeconds: number, autoStopSeconds: number): number[] {
  const rungs = new Set<number>([
    ...INACTIVITY_POLICY.PROBE_LADDER_SECONDS,
    Math.max(15, Math.round(thresholdSeconds)),
    Math.max(15, Math.round(autoStopSeconds)),
  ]);
  return [...rungs].filter((s) => Number.isFinite(s) && s >= 15).sort((a, b) => a - b);
}

/**
 * Turn `queryState` answers into bounds on the time since the last input.
 *
 * `queryState(n)` is 'active' when input happened within n seconds, so every
 * active rung is an upper bound and every idle/locked rung a lower bound. The
 * probes are not simultaneous: input landing between two of them can make a
 * smaller rung idle and a larger one active. That contradiction means input
 * just happened, and is resolved as activity.
 */
export function idleBoundsFromProbes(
  probes: Array<{ intervalSeconds: number; state: OsIdleState }>,
): IdleBounds {
  let minSeconds = 0;
  let maxSeconds: number | null = null;
  for (const probe of probes) {
    if (probe.state === 'active') {
      maxSeconds =
        maxSeconds == null ? probe.intervalSeconds : Math.min(maxSeconds, probe.intervalSeconds);
    } else {
      minSeconds = Math.max(minSeconds, probe.intervalSeconds);
    }
  }
  if (maxSeconds != null && minSeconds >= maxSeconds) return { minSeconds: 0, maxSeconds };
  return { minSeconds, maxSeconds };
}

/** The OS says input happened within `withinSeconds`. */
function inputWithin(bounds: IdleBounds | null, withinSeconds: number): boolean {
  return bounds != null && bounds.maxSeconds != null && bounds.maxSeconds <= withinSeconds;
}

/** The latest instant input can have happened at (ms), given the bounds. */
function latestPossibleInputMs(bounds: IdleBounds, nowMs: number): number {
  return nowMs - bounds.minSeconds * 1000;
}

/** The earliest instant the last input can have happened at (ms), or null if unbounded. */
function earliestPossibleInputMs(bounds: IdleBounds, nowMs: number): number | null {
  return bounds.maxSeconds == null ? null : nowMs - bounds.maxSeconds * 1000;
}

/**
 * Did input happen after an idle stretch that began at `sinceMs`?
 *
 * Two independent proofs. Directly: the earliest the last input can have been
 * is after `sinceMs`. Indirectly: every source only opens a period once the OS
 * idle counter has passed the threshold, and that counter only goes down on
 * input — so a reading below the threshold (less the slack) means input
 * happened after the period opened, however recently it opened. The second is
 * what closes a period opened seconds ago, below the resolution of the first.
 */
function inputSince(
  bounds: IdleBounds,
  sinceMs: number,
  nowMs: number,
  thresholdSeconds: number,
): { happened: boolean; earliestMs: number } {
  const earliest = earliestPossibleInputMs(bounds, nowMs);
  const belowThreshold = inputWithin(
    bounds,
    Math.max(15, thresholdSeconds - INACTIVITY_POLICY.CONFIRM_SLACK_SECONDS),
  );
  const happened = (earliest != null && earliest > sinceMs) || belowThreshold;
  return { happened, earliestMs: Math.max(earliest ?? nowMs, sinceMs) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ms(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampToNotBefore(atMs: number, tracker: InactivityTracker): number {
  const floor = ms(tracker.notBefore);
  return floor != null && atMs < floor ? floor : atMs;
}

function open(tracker: InactivityTracker, atMs: number, reason: string): InactivityDecision {
  const at = iso(clampToNotBefore(atMs, tracker));
  return {
    tracker: { ...tracker, openSince: at, pendingSince: null },
    commands: [{ kind: 'open', at }],
    reason,
  };
}

function close(tracker: InactivityTracker, atMs: number, reason: string): InactivityDecision {
  const since = ms(tracker.openSince);
  // Never before the period began: a zero-length period is discarded by the
  // server as below the threshold, which is exactly right for one that was
  // never real.
  const at = iso(since != null && atMs < since ? since : atMs);
  return {
    tracker: { ...tracker, openSince: null, pendingSince: null },
    commands: [{ kind: 'close', at }],
    reason,
  };
}

function unchanged(tracker: InactivityTracker, reason?: string): InactivityDecision {
  return { tracker, commands: [], reason };
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * The agent says input stopped at `startedAt` and has now been absent past the
 * threshold.
 *
 * Opened only if the OS does not contradict it. If the OS reports input more
 * recently than the threshold (less the slack), the event is held as pending
 * and the next reconcile decides — so an agent that is wrong, or a stale event
 * from before a restart, cannot open a period over someone who is working.
 */
export function agentIdleStarted(
  tracker: InactivityTracker,
  startedAt: string,
  bounds: IdleBounds | null,
  thresholdSeconds: number,
): InactivityDecision {
  if (tracker.openSince) return unchanged(tracker, 'already open');
  const startedMs = ms(startedAt);
  if (startedMs == null) return unchanged(tracker, 'unreadable start');

  const confirmWithin = Math.max(15, thresholdSeconds - INACTIVITY_POLICY.CONFIRM_SLACK_SECONDS);
  if (inputWithin(bounds, confirmWithin)) {
    return unchanged(
      { ...tracker, pendingSince: startedAt },
      'agent idle not confirmed by the OS yet',
    );
  }
  return open(tracker, startedMs, 'agent reported idle');
}

/**
 * Any source says input resumed. Always honoured, whichever source opened the
 * period — refusing an "active" because someone else owns detection is how a
 * period used to stay open for the rest of a session.
 */
export function idleEnded(tracker: InactivityTracker, endedAt: string): InactivityDecision {
  if (!tracker.openSince) {
    return tracker.pendingSince
      ? unchanged({ ...tracker, pendingSince: null }, 'pending idle cancelled')
      : unchanged(tracker);
  }
  const endedMs = ms(endedAt);
  if (endedMs == null) return unchanged(tracker, 'unreadable end');
  return close(tracker, endedMs, 'input resumed');
}

/**
 * `chrome.idle` changed state.
 *
 * 'active' always closes. 'idle'/'locked' opens only when the agent does not
 * own detection; when it does, the agent's own report (which knows the real
 * start) is awaited, and reconcile covers the case where it never comes.
 */
export function browserIdleChanged(
  tracker: InactivityTracker,
  newState: OsIdleState,
  nowMs: number,
  agentOwnsDetection: boolean,
): InactivityDecision {
  if (newState === 'active') return idleEnded(tracker, iso(nowMs));
  if (tracker.openSince || agentOwnsDetection) return unchanged(tracker);
  // The period starts when the threshold was reached, never back-dated past it
  // — chrome.idle cannot say when input actually stopped.
  return open(tracker, nowMs, 'browser reported idle');
}

// ─── The safety net ───────────────────────────────────────────────────────────

/**
 * Bring the tracker in line with what the OS reports right now.
 *
 * Run every minute, and it is the reason a lost event cannot corrupt a report:
 *
 *  - a period is open, and the OS reports input after it began → it ended;
 *    closed at the earliest moment that input can have happened;
 *  - a pending agent report is confirmed by the OS → opened at the agent's
 *    start; contradicted by input after it → dropped;
 *  - nothing is open but the OS reports no input for the whole threshold → an
 *    idle event was lost; opened at the latest moment input can have stopped.
 *
 * With no OS reading (`bounds` null) nothing is changed: guessing would be
 * worse than waiting a minute.
 */
export function reconcileInactivity(
  tracker: InactivityTracker,
  bounds: IdleBounds | null,
  nowMs: number,
  thresholdSeconds: number,
): InactivityDecision {
  if (!bounds) return unchanged(tracker);

  const openMs = ms(tracker.openSince);
  if (openMs != null) {
    const input = inputSince(bounds, openMs, nowMs, thresholdSeconds);
    if (input.happened) {
      return close(tracker, input.earliestMs, 'the OS reports input after the period began');
    }
    return unchanged(tracker);
  }

  const pendingMs = ms(tracker.pendingSince);
  if (pendingMs != null) {
    const earliestInput = earliestPossibleInputMs(bounds, nowMs);
    if (earliestInput != null && earliestInput > pendingMs) {
      return unchanged({ ...tracker, pendingSince: null }, 'pending idle contradicted by input');
    }
    const confirmWithin = Math.max(15, thresholdSeconds - INACTIVITY_POLICY.CONFIRM_SLACK_SECONDS);
    if (!inputWithin(bounds, confirmWithin)) {
      return open(tracker, pendingMs, 'pending agent idle confirmed by the OS');
    }
    return unchanged(tracker);
  }

  if (bounds.minSeconds >= thresholdSeconds) {
    return open(
      tracker,
      latestPossibleInputMs(bounds, nowMs),
      'idle past the threshold with no event',
    );
  }
  return unchanged(tracker);
}

// ─── Auto-stop ────────────────────────────────────────────────────────────────

/**
 * When monitoring should have stopped itself for inactivity, or null.
 *
 * Two independent kinds of evidence, either sufficient:
 *  - the OS reports no input for the whole limit;
 *  - a period has been open for the whole limit and the OS does not report
 *    input since it began.
 *
 * The stop time is the moment the limit was reached — not "now", which after a
 * sleep could be hours later — and never in the future.
 */
export function autoStopAt(
  tracker: InactivityTracker,
  bounds: IdleBounds | null,
  nowMs: number,
  thresholdSeconds: number,
  limitMs: number = INACTIVITY_POLICY.AUTO_STOP_AFTER_MS,
): number | null {
  const candidates: number[] = [];

  if (bounds && bounds.minSeconds * 1000 >= limitMs) {
    candidates.push(latestPossibleInputMs(bounds, nowMs) + limitMs);
  }

  const openMs = ms(tracker.openSince);
  if (openMs != null && nowMs - openMs >= limitMs) {
    const contradicted =
      bounds != null && inputSince(bounds, openMs, nowMs, thresholdSeconds).happened;
    if (!contradicted) candidates.push(openMs + limitMs);
  }

  if (candidates.length === 0) return null;
  const floor = ms(tracker.notBefore);
  const at = Math.min(...candidates, nowMs);
  return floor != null && at < floor ? floor : at;
}

// ─── A machine that was not running the session ───────────────────────────────

/**
 * When a session should have ended because this machine was not running it.
 *
 * Shut down, asleep, Chrome closed or crashed, the extension killed: all look
 * the same from here — the liveness log simply stops. A short gap is recovered
 * from (the session continues, re-settled if the server expired it). A gap as
 * long as the inactivity auto-stop is not: nobody was being monitored for an
 * hour, and silently resuming the next morning would stretch one session over
 * a night. It ends at the last moment the machine was running it — never at the
 * moment it woke up.
 */
export function awayStopAt(
  lastAliveMs: number | null,
  nowMs: number,
  limitMs: number = INACTIVITY_POLICY.AUTO_STOP_AFTER_MS,
): number | null {
  if (lastAliveMs == null || !Number.isFinite(lastAliveMs)) return null;
  return nowMs - lastAliveMs >= limitMs ? lastAliveMs : null;
}

/**
 * When monitoring should stop because the device lost its network, or null.
 *
 * Only a device that is itself offline (`navigator.onLine` false) counts: a
 * backend that is down while the device is online keeps monitoring and uploads
 * later. The stop is dated to when the network was lost, not when it was
 * noticed to have stayed lost.
 */
export function offlineStopAt(
  networkLostAtMs: number | null,
  nowMs: number,
  online: boolean,
  graceMs: number = INACTIVITY_POLICY.NETWORK_LOSS_GRACE_MS,
): number | null {
  if (online || networkLostAtMs == null || !Number.isFinite(networkLostAtMs)) return null;
  return nowMs - networkLostAtMs >= graceMs ? networkLostAtMs : null;
}

// ─── Session hand-off ─────────────────────────────────────────────────────────

/**
 * The live session named in a MONITORING_ALREADY_ACTIVE refusal.
 *
 * The server says "session <uuid> is already running on this project". The id
 * is what lets a Start resolve the conflict instead of pretending to monitor.
 */
export function parseLiveSessionId(message: string | null | undefined): string | null {
  if (!message) return null;
  const match = /session\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    message,
  );
  return match ? match[1].toLowerCase() : null;
}

// ─── Agent liveness ───────────────────────────────────────────────────────────

/**
 * Has the agent genuinely stopped answering?
 *
 * Its heartbeats stop arriving in two very different situations: the agent is
 * wedged, or the whole machine was asleep. Reconnecting in the second case
 * kills a perfectly healthy agent process — and with it the open activity
 * interval and any open idle period it was tracking. So silence only counts if
 * this worker was itself running (checking) through it.
 */
export function agentHeartbeatStale(options: {
  nowMs: number;
  lastHeartbeatMs: number;
  lastCheckMs: number;
  staleAfterMs: number;
}): 'stale' | 'fresh' | 'woke-from-sleep' {
  const { nowMs, lastHeartbeatMs, lastCheckMs, staleAfterMs } = options;
  if (lastCheckMs > 0 && nowMs - lastCheckMs > staleAfterMs) return 'woke-from-sleep';
  if (lastHeartbeatMs === 0) return 'fresh';
  return nowMs - lastHeartbeatMs > staleAfterMs ? 'stale' : 'fresh';
}
