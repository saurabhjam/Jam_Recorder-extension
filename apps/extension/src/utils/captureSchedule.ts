/**
 * Deadline arithmetic for the monitoring capture scheduler.
 *
 * Extracted from the capture loop so the one thing that must be exactly right —
 * that a 60-second interval produces a screenshot at 10:00:00, 10:01:00,
 * 10:02:00 … regardless of how long each capture and upload takes — can be
 * tested without a browser, a screen or a network.
 *
 * ── The two wrong ways to do this ────────────────────────────────────────────
 * 1. `setInterval(capture, ms)` with an in-flight guard. Ticks that land while
 *    the previous capture is still uploading are silently dropped, so the real
 *    cadence degrades exactly when the network is slow — and nothing reports it.
 * 2. `setTimeout(…, ms)` re-armed *after* each capture completes. This adds the
 *    whole capture+upload latency to every gap: a 60s interval with a 5s upload
 *    becomes 65s, then 65s again, drifting permanently.
 *
 * The fix is to treat the schedule as a series of absolute deadlines and derive
 * each wait from the next deadline rather than from when work finished.
 */

export interface ScheduleDecision {
  /** Epoch ms of the deadline that should fire next. */
  nextCaptureAt: number;
  /** How long to wait from `now`. Never negative. */
  delayMs: number;
  /**
   * Deadlines that were skipped because they are already in the past.
   *
   * Non-zero after the machine slept or the document was throttled. They are
   * skipped rather than fired as a burst: several captures a second apart would
   * all show the same screen, and firing them would also push the schedule
   * further behind.
   */
  missedDeadlines: number;
}

/**
 * Advance the schedule to the next deadline at or after `now`.
 *
 * `previousDeadline` of 0 (or anything non-finite) means "no schedule yet", and
 * the first deadline is placed one full interval ahead — the initial capture is
 * taken separately, at start, so the first *scheduled* frame is one interval in.
 */
export function nextDeadline(
  previousDeadline: number,
  intervalMs: number,
  now: number,
): ScheduleDecision {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('captureSchedule: intervalMs must be a positive number');
  }

  if (!Number.isFinite(previousDeadline) || previousDeadline <= 0) {
    const first = now + intervalMs;
    return { nextCaptureAt: first, delayMs: intervalMs, missedDeadlines: 0 };
  }

  let deadline = previousDeadline;
  let missedDeadlines = 0;
  // Walk forward in whole intervals. This is what keeps every deadline on the
  // original grid: the sequence stays 10:00:00, 10:01:00, 10:02:00 even if the
  // process was asleep from 10:00:30 to 10:02:30.
  while (deadline <= now) {
    deadline += intervalMs;
    missedDeadlines += 1;
  }
  // The first step off a deadline that had already arrived is the normal
  // advance, not a miss.
  if (missedDeadlines > 0) missedDeadlines -= 1;

  return {
    nextCaptureAt: deadline,
    delayMs: Math.max(0, deadline - now),
    missedDeadlines,
  };
}

/**
 * Deadline immediately following one that has just fired.
 *
 * Called *before* the capture runs, so the next gap is measured from the
 * intended time rather than from whenever the capture happens to finish. This
 * is the single line that makes latency irrelevant to the cadence.
 */
export function advanceDeadline(firedDeadline: number, intervalMs: number): number {
  return firedDeadline + intervalMs;
}

/**
 * Is a capture overdue by enough to call the loop unhealthy?
 *
 * Two intervals plus a minute of slack. One missed deadline happens for
 * innocent reasons — a slow frame, a deferred deadline while the previous
 * upload finished — but two in a row means something is actually wrong, and the
 * user must be told rather than shown a reassuring "Monitoring Active".
 */
export function isCaptureOverdue(
  lastSuccessAtMs: number | null,
  intervalMs: number,
  now: number,
): boolean {
  if (lastSuccessAtMs == null) return false;
  return now - lastSuccessAtMs > intervalMs * 2 + 60_000;
}

/**
 * The grid of deadlines a run would produce, for verification and diagnostics.
 *
 * Exists so the no-drift property can be asserted directly rather than
 * inferred: feed it a set of capture durations and the deadlines must stay on
 * the original grid.
 */
export function simulateSchedule(
  startMs: number,
  intervalMs: number,
  captureDurationsMs: number[],
): number[] {
  const fired: number[] = [];
  let deadline = startMs + intervalMs;
  let clock = startMs;

  for (const duration of captureDurationsMs) {
    // Time advances to the deadline (or stays put if we are already past it),
    // then the capture takes however long it takes.
    clock = Math.max(clock, deadline);
    fired.push(deadline);
    deadline = advanceDeadline(deadline, intervalMs);
    clock += duration;
    // A capture that overran its slot pushes the schedule forward to the next
    // future deadline instead of firing a backlog.
    const decision = nextDeadline(deadline, intervalMs, clock);
    deadline = decision.nextCaptureAt;
  }

  return fired;
}
