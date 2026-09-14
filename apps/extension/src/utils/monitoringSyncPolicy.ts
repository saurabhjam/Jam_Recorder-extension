/**
 * Monitoring sync — the decisions, with no I/O.
 *
 * Everything here is a pure function of its arguments, so the rules that decide
 * whether monitoring data is kept, retried, paced or given up on can be tested
 * directly (see test/monitoringSyncPolicy.test.mjs) instead of being inferred
 * from an outage.
 *
 * ── The two promises this file exists to keep ────────────────────────────────
 *  1. Nothing is thrown away because the server could not be reached. Only an
 *     answer FROM the monitoring API saying "this can never be accepted" ends an
 *     item's life. A dead network, a 502 from a gateway mid-deploy, an expired
 *     token and a rate limit all mean "later", never "never".
 *  2. A server that comes back is not flattened by what piled up while it was
 *     gone. New data keeps flowing at its normal rate; the backlog goes up in
 *     small batches minutes apart, jittered so a whole office of clients
 *     recovering from the same outage does not arrive in the same second.
 */

export const SYNC_POLICY = {
  /** Younger than this is "live" and sent immediately; older is backlog. */
  LIVE_WINDOW_MS: 3 * 60_000,

  /** Backlog cadence: one batch, then this long (plus jitter) before the next. */
  BACKLOG_INTERVAL_MS: 2 * 60_000,
  BACKLOG_JITTER_MS: 60_000,
  BACKLOG_SNAPSHOTS_PER_BATCH: 15,
  BACKLOG_ACTIVITIES_PER_BATCH: 500,

  /**
   * How long after recovery the first backlog batch waits.
   *
   * Every client that lost the server at the same moment notices its return
   * within the same probe window. Spreading the first batch across 15–60s is
   * what stops that from becoming a synchronised burst.
   */
  RECOVERY_DELAY_MIN_MS: 15_000,
  RECOVERY_DELAY_MAX_MS: 60_000,

  LIVE_SNAPSHOTS_PER_PASS: 5,
  EVENTS_PER_SESSION_PER_PASS: 20,

  /** Probe cadence while the server is unreachable. Caps at five minutes. */
  PROBE_BACKOFF_MS: [30_000, 60_000, 120_000, 240_000, 300_000],
  PROBE_JITTER_RATIO: 0.2,

  /** The server said "too many requests"; back off harder than for an outage. */
  THROTTLE_BACKOFF_MS: 90_000,

  /** Per-item retry spacing, so one bad item is not retried on every pass. */
  ITEM_BACKOFF_BASE_MS: 5_000,
  ITEM_BACKOFF_MAX_MS: 30 * 60_000,

  /**
   * Retry spacing for an item that failed during an outage. Longer than the
   * first probe interval, so successive probes rotate through different items —
   * one item the server chokes on cannot be the only thing ever used to test
   * whether it is back.
   */
  UNCOUNTED_RETRY_MS: 60_000,

  /**
   * Failures counted against an item while the server was demonstrably
   * answering. They lengthen its retry spacing but never end its life on their
   * own; only once it is also older than PARKED_MAX_AGE_MS — past anything the
   * server would accept — is an item this troubled given up on.
   */
  MAX_ATTEMPTS_WHILE_REACHABLE: 20,

  /** Retry spacing for an item the server could not place anywhere yet. */
  PARK_RETRY_MS: 15 * 60_000,
  /** A parked item this old is past anything the server would accept. */
  PARKED_MAX_AGE_MS: 48 * 3_600_000,

  /** Dead items are kept this long as evidence, then purged. */
  DEAD_RETENTION_MS: 7 * 24 * 3_600_000,

  /**
   * How long the stop waits for the session's live data to land first.
   *
   * Bounded because an older server refuses data after a stop, but a stop held
   * indefinitely would leave the session live on the server long after the
   * person stopped.
   */
  STOP_HOLD_MS: 90_000,

  /**
   * A gap in the liveness log longer than this means the machine slept or the
   * browser was closed. Matches the server's heartbeat timeout, so a gap short
   * enough that the server would have kept the session is treated the same way
   * here.
   */
  LIVENESS_GAP_MS: 15 * 60_000,
  MAX_LIVENESS_SEGMENTS: 200,

  /**
   * Storage bounds. Roughly a day of 30-second screenshots — the server rejects
   * timestamps older than a day, so keeping more buys nothing.
   */
  MAX_SNAPSHOTS: 3_000,
  MAX_SNAPSHOT_BYTES: 300 * 1024 * 1024,
  MAX_ACTIVITIES: 50_000,
  MAX_EVENTS: 10_000,
} as const;

// ─── Failure classification ───────────────────────────────────────────────────

/**
 * What a failed request means for the item that made it.
 *
 *   duplicate           already stored — the item is done
 *   transient           server/network unavailable — retry, and pause everything
 *   throttled           rate limited — retry, and pause everything for longer
 *   auth                token missing or expired — retry once the user signs in
 *   session-closed      the session no longer accepts this — re-home or park
 *   reservation-lost    the snapshot grant is gone — start that upload over
 *   inactivity-missing  nothing open to close — already closed server-side
 *   overlap             inactivity already recorded for that stretch
 *   rejected            the monitoring API refused the content itself — final
 *   unrecognised        a 4xx that did not come from the monitoring API — park
 */
export type FailureKind =
  | 'duplicate'
  | 'transient'
  | 'throttled'
  | 'auth'
  | 'session-closed'
  | 'reservation-lost'
  | 'inactivity-missing'
  | 'overlap'
  | 'rejected'
  | 'unrecognised';

export function classifyFailure(failure: { status: number; code: string | null }): FailureKind {
  switch (failure.code) {
    case 'MONITORING_DUPLICATE_SNAPSHOT':
      return 'duplicate';
    case 'MONITORING_SESSION_NOT_ACTIVE':
      return 'session-closed';
    // Mapped by the server onto FORBIDDEN_OPERATION, so the status alone reads
    // as a permanent refusal. It is the opposite: the request was fine, there
    // were just too many of them.
    case 'MONITORING_RATE_LIMIT_EXCEEDED':
      return 'throttled';
    case 'MONITORING_SNAPSHOT_NOT_FOUND':
      return 'reservation-lost';
    case 'MONITORING_INACTIVITY_NOT_FOUND':
      return 'inactivity-missing';
    case 'MONITORING_OVERLAPPING_INACTIVITY':
      return 'overlap';
    // Storage could not take or find the bytes. That is the storage tier being
    // unavailable, not the image being wrong.
    case 'MONITORING_UPLOAD_FAILED':
      return 'transient';
    default:
      break;
  }

  const { status } = failure;
  if (status === 0 || status === 408 || status === 425 || status >= 500) return 'transient';
  if (status === 429) return 'throttled';
  if (status === 401) return 'auth';

  // Any other MONITORING_* answer is the monitoring API's own verdict on the
  // payload — a bad timestamp, an invalid period — and asking again cannot
  // change it.
  if (failure.code) return 'rejected';

  // A 4xx with no monitoring code came from something in front of the API: a
  // gateway serving an error page mid-deploy, a permission layer. Not a verdict
  // on the data, so it must not destroy it.
  return 'unrecognised';
}

/** True for failures that mean "the server is not usable right now". */
export function haltsSync(kind: FailureKind): boolean {
  return kind === 'transient' || kind === 'throttled' || kind === 'auth';
}

// ─── Timing ───────────────────────────────────────────────────────────────────

/** Delay before the next probe of an unreachable server. */
export function probeDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const ladder = SYNC_POLICY.PROBE_BACKOFF_MS;
  const index = Math.min(Math.max(consecutiveFailures, 1), ladder.length) - 1;
  const base = ladder[index];
  const spread = base * SYNC_POLICY.PROBE_JITTER_RATIO;
  return Math.round(base - spread + random() * spread * 2);
}

/** Delay before the next backlog batch. */
export function backlogDelayMs(random: () => number = Math.random): number {
  return Math.round(SYNC_POLICY.BACKLOG_INTERVAL_MS + random() * SYNC_POLICY.BACKLOG_JITTER_MS);
}

/** Delay before the first backlog batch after the server comes back. */
export function recoveryDelayMs(random: () => number = Math.random): number {
  const min = SYNC_POLICY.RECOVERY_DELAY_MIN_MS;
  return Math.round(min + random() * (SYNC_POLICY.RECOVERY_DELAY_MAX_MS - min));
}

/** Spacing between retries of one item. Exponential, capped. */
export function itemBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(
    SYNC_POLICY.ITEM_BACKOFF_BASE_MS * 2 ** exponent,
    SYNC_POLICY.ITEM_BACKOFF_MAX_MS,
  );
}

export type SyncLane = 'live' | 'backlog';

/** Which lane an item belongs to, by when it was produced. */
export function laneOf(producedAtMs: number, nowMs: number): SyncLane {
  return nowMs - producedAtMs <= SYNC_POLICY.LIVE_WINDOW_MS ? 'live' : 'backlog';
}

// ─── Liveness ─────────────────────────────────────────────────────────────────

/**
 * Stretches of time this client is known to have been running.
 *
 * Needed for one question only: when the server expired a session because it
 * heard nothing, how long was the client *actually* running? A four-hour network
 * outage and a four-hour closed laptop both look like silence from the server,
 * but only the first was monitored time — and only the client knows which.
 */
export interface LivenessSegment {
  from: number;
  to: number;
}

/** Record that the client was running at `atMs`. Returns a new array. */
export function extendLiveness(
  segments: LivenessSegment[],
  atMs: number,
  gapMs: number = SYNC_POLICY.LIVENESS_GAP_MS,
): LivenessSegment[] {
  const next = segments.map((segment) => ({ ...segment }));
  const last = next[next.length - 1];
  if (last && atMs >= last.from && atMs - last.to <= gapMs) {
    last.to = Math.max(last.to, atMs);
  } else if (!last || atMs > last.to) {
    next.push({ from: atMs, to: atMs });
  }
  return next.slice(-SYNC_POLICY.MAX_LIVENESS_SEGMENTS);
}

/**
 * When a session really ended, as far as the client can vouch for.
 *
 * The run of liveness that contains the last moment the server heard from the
 * client is extended as far as it goes — through a network outage, which the
 * client ran through — and stops at the first gap, which is a sleep or a closed
 * browser that nobody should be credited for. Never later than `atMs`.
 */
export function settledEndMs(
  segments: LivenessSegment[],
  lastContactMs: number | null,
  atMs: number,
  gapMs: number = SYNC_POLICY.LIVENESS_GAP_MS,
): number {
  if (lastContactMs == null) return atMs;
  const containing = segments.find(
    (segment) => lastContactMs >= segment.from - gapMs && lastContactMs <= segment.to + gapMs,
  );
  // No log covering the contact — nothing to vouch with beyond the contact.
  if (!containing) return Math.min(atMs, lastContactMs);
  return Math.min(atMs, Math.max(containing.to, lastContactMs));
}

/** Start of the run of liveness that `atMs` belongs to. */
export function currentRunStartMs(
  segments: LivenessSegment[],
  atMs: number,
  gapMs: number = SYNC_POLICY.LIVENESS_GAP_MS,
): number {
  const last = segments[segments.length - 1];
  if (!last || atMs - last.to > gapMs || atMs < last.from) return atMs;
  return last.from;
}

// ─── Storage pressure ─────────────────────────────────────────────────────────

/**
 * Which screenshots to drop when the store is over its bound.
 *
 * Thins rather than truncates. Dropping the oldest N would leave a solid hole
 * at the start of the outage; removing the frame whose neighbours are closest
 * together keeps coverage spread across the whole period at a lower density.
 * Stable across calls — repeated overflow keeps halving density evenly instead
 * of eating one end.
 *
 * `capturedAtMs` must be sorted ascending. Frames at or after `protectFromMs`
 * (the live window) and the very first and last are never chosen.
 * Returns indices into `capturedAtMs`.
 */
export function pickThinningVictims(
  capturedAtMs: number[],
  count: number,
  protectFromMs: number = Number.POSITIVE_INFINITY,
): number[] {
  const alive = capturedAtMs.map((_, index) => index);
  const victims: number[] = [];

  while (victims.length < count) {
    let best = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (let position = 1; position < alive.length - 1; position++) {
      const index = alive[position];
      if (capturedAtMs[index] >= protectFromMs) break;
      const span = capturedAtMs[alive[position + 1]] - capturedAtMs[alive[position - 1]];
      if (span < bestSpan) {
        bestSpan = span;
        best = position;
      }
    }
    if (best === -1) break;
    victims.push(alive[best]);
    alive.splice(best, 1);
  }
  return victims;
}

// ─── Activity batch responses ─────────────────────────────────────────────────

/**
 * Per-row errors from an activity batch.
 *
 * The server reports each refused row as `"<clientActivityId>: <reason>"`.
 * Everything not named was accepted or was already there.
 */
export function parseBatchErrors(errors: string[] | null | undefined): Map<string, string> {
  const byId = new Map<string, string>();
  for (const line of errors ?? []) {
    const separator = line.indexOf(': ');
    if (separator <= 0) continue;
    byId.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return byId;
}

// ─── Sessions that closed underneath their data ───────────────────────────────

/**
 * Where an item goes when its own session no longer takes it.
 *
 * Only to a successor that had already begun when the item was produced — an
 * item from before the successor started belongs to time that session does
 * not cover, and filing it there would put it outside its own session.
 */
export function successorFor(
  session: { successorId: string | null; successorStartedAtMs: number | null } | null | undefined,
  producedAtMs: number,
): string | null {
  if (!session?.successorId || session.successorStartedAtMs == null) return null;
  return producedAtMs >= session.successorStartedAtMs ? session.successorId : null;
}
