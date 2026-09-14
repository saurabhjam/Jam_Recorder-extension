/**
 * Tests for the monitoring sync policy.
 *
 * The properties that must hold, whatever else changes:
 *  - a server that cannot be reached never causes data to be discarded;
 *  - only the monitoring API's own verdict on the data ends an item's life;
 *  - a recovered server receives the backlog in small, spaced, jittered batches;
 *  - an expired session is re-settled through a network outage, but not
 *    through a sleep;
 *  - storage pressure thins old screenshots instead of cutting a hole.
 *
 * Run with `npm run test` (which compiles the TypeScript source first, so these
 * exercise the real module rather than a copy).
 */

import {
  SYNC_POLICY,
  classifyFailure,
  haltsSync,
  probeDelayMs,
  backlogDelayMs,
  recoveryDelayMs,
  itemBackoffMs,
  laneOf,
  extendLiveness,
  settledEndMs,
  currentRunStartMs,
  pickThinningVictims,
  parseBatchErrors,
  successorFor,
} from './.build/monitoringSyncPolicy.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };

const T0 = Date.parse('2026-09-14T08:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

// ── An unreachable server is never a reason to discard ──
t('network failure, 5xx and gateway timeouts are transient and pause sync', () => {
  for (const status of [0, 408, 500, 502, 503, 504]) {
    eq(classifyFailure({ status, code: null }), 'transient', `status ${status}`);
    ok(haltsSync('transient'));
  }
});

t('an expired sign-in is retried, not dropped', () => {
  eq(classifyFailure({ status: 401, code: null }), 'auth');
  ok(haltsSync('auth'));
});

t('rate limiting is throttling even though the server maps it to a 4xx', () => {
  eq(classifyFailure({ status: 406, code: 'MONITORING_RATE_LIMIT_EXCEEDED' }), 'throttled');
  eq(classifyFailure({ status: 403, code: 'MONITORING_RATE_LIMIT_EXCEEDED' }), 'throttled');
  eq(classifyFailure({ status: 429, code: null }), 'throttled');
});

t('storage failing to take the bytes is transient', () => {
  eq(classifyFailure({ status: 500, code: 'MONITORING_UPLOAD_FAILED' }), 'transient');
});

t('a 4xx with no monitoring code (gateway, proxy) parks instead of killing', () => {
  eq(classifyFailure({ status: 404, code: null }), 'unrecognised');
  eq(classifyFailure({ status: 403, code: null }), 'unrecognised');
  eq(classifyFailure({ status: 400, code: null }), 'unrecognised');
  ok(!haltsSync('unrecognised'));
});

t('only a MONITORING_* verdict on the content is final', () => {
  eq(classifyFailure({ status: 400, code: 'MONITORING_INVALID_TIMESTAMP' }), 'rejected');
  eq(classifyFailure({ status: 400, code: 'MONITORING_INVALID_SNAPSHOT' }), 'rejected');
});

t('server answers that mean "already done" are recognised', () => {
  eq(classifyFailure({ status: 409, code: 'MONITORING_DUPLICATE_SNAPSHOT' }), 'duplicate');
  eq(classifyFailure({ status: 400, code: 'MONITORING_OVERLAPPING_INACTIVITY' }), 'overlap');
  eq(classifyFailure({ status: 404, code: 'MONITORING_INACTIVITY_NOT_FOUND' }), 'inactivity-missing');
});

t('a closed session is its own outcome, not a rejection', () => {
  eq(classifyFailure({ status: 406, code: 'MONITORING_SESSION_NOT_ACTIVE' }), 'session-closed');
  eq(classifyFailure({ status: 404, code: 'MONITORING_SNAPSHOT_NOT_FOUND' }), 'reservation-lost');
});

// ── Probing an unreachable server ──
t('probe backoff climbs 30s → 5min and stays there', () => {
  const mid = () => 0.5;
  eq([1, 2, 3, 4, 5, 6, 50].map((n) => probeDelayMs(n, mid)),
     [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

t('probe backoff is jittered within ±20%', () => {
  eq(probeDelayMs(1, () => 0), 24_000);
  eq(probeDelayMs(1, () => 1), 36_000);
});

// ── Recovery pacing ──
t('the first backlog batch after recovery waits 15–60s', () => {
  eq(recoveryDelayMs(() => 0), 15_000);
  eq(recoveryDelayMs(() => 1), 60_000);
});

t('backlog batches are 2–3 minutes apart', () => {
  eq(backlogDelayMs(() => 0), 2 * MIN);
  eq(backlogDelayMs(() => 1), 3 * MIN);
});

t('a 4-hour backlog of 30s screenshots is never sent in one go', () => {
  const backlog = 4 * 120; // 480 frames
  const batches = Math.ceil(backlog / SYNC_POLICY.BACKLOG_SNAPSHOTS_PER_BATCH);
  ok(SYNC_POLICY.BACKLOG_SNAPSHOTS_PER_BATCH <= 20, 'a batch must stay small');
  // Fastest possible drain: every gap at its minimum.
  const fastestMinutes = ((batches - 1) * backlogDelayMs(() => 0)) / MIN;
  ok(fastestMinutes >= 60, `drained in ${fastestMinutes} min — too aggressive`);
  // And it does finish: slowest drain still within a working morning.
  const slowestMinutes = ((batches - 1) * backlogDelayMs(() => 1)) / MIN;
  ok(slowestMinutes <= 120, `drained in ${slowestMinutes} min — too slow`);
});

t('the last few minutes are live, everything older is backlog', () => {
  const now = T0 + HOUR;
  eq(laneOf(now - MIN, now), 'live');
  eq(laneOf(now - SYNC_POLICY.LIVE_WINDOW_MS, now), 'live');
  eq(laneOf(now - SYNC_POLICY.LIVE_WINDOW_MS - 1, now), 'backlog');
  eq(laneOf(now - 4 * HOUR, now), 'backlog');
});

t('per-item backoff is exponential and capped at 30 minutes', () => {
  eq([1, 2, 3].map(itemBackoffMs), [5_000, 10_000, 20_000]);
  eq(itemBackoffMs(40), 30 * MIN);
});

// ── Liveness: outage vs sleep ──
const ticksEveryMinute = (from, to, start = []) => {
  let segments = start;
  for (let at = from; at <= to; at += MIN) segments = extendLiveness(segments, at);
  return segments;
};

t('minute ticks through a network outage form one continuous run', () => {
  const segments = ticksEveryMinute(T0, T0 + 4 * HOUR);
  eq(segments.length, 1);
  eq(segments[0], { from: T0, to: T0 + 4 * HOUR });
});

t('a gap longer than the heartbeat timeout starts a new run', () => {
  let segments = ticksEveryMinute(T0, T0 + 5 * MIN);
  segments = ticksEveryMinute(T0 + 3 * HOUR, T0 + 3 * HOUR + 2 * MIN, segments);
  eq(segments.length, 2);
  eq(segments[1].from, T0 + 3 * HOUR);
});

t('a short sleep does not break the run', () => {
  let segments = ticksEveryMinute(T0, T0 + 5 * MIN);
  segments = ticksEveryMinute(T0 + 15 * MIN, T0 + 20 * MIN, segments);
  eq(segments.length, 1);
});

t('an out-of-order timestamp never rewrites history', () => {
  const segments = extendLiveness([{ from: T0, to: T0 + HOUR }], T0 - HOUR);
  eq(segments, [{ from: T0, to: T0 + HOUR }]);
});

t('re-settle after a 4h outage covers the whole outage', () => {
  const segments = ticksEveryMinute(T0, T0 + 4 * HOUR);
  eq(settledEndMs(segments, T0 + MIN, T0 + 4 * HOUR), T0 + 4 * HOUR);
});

t('re-settle after the laptop slept stops where the sleep began', () => {
  let segments = ticksEveryMinute(T0, T0 + 5 * MIN);
  segments = ticksEveryMinute(T0 + 4 * HOUR, T0 + 4 * HOUR + MIN, segments);
  eq(settledEndMs(segments, T0 + 2 * MIN, T0 + 4 * HOUR + MIN), T0 + 5 * MIN);
});

t('re-settle never goes past the moment asked about', () => {
  const segments = ticksEveryMinute(T0, T0 + HOUR);
  eq(settledEndMs(segments, T0 + MIN, T0 + 30 * MIN), T0 + 30 * MIN);
});

t('no log covering the contact means no credit beyond the contact', () => {
  eq(settledEndMs([], T0, T0 + HOUR), T0);
  eq(settledEndMs([], null, T0 + HOUR), T0 + HOUR);
});

t('the continuation starts where the current run began', () => {
  let segments = ticksEveryMinute(T0, T0 + 5 * MIN);
  segments = ticksEveryMinute(T0 + 4 * HOUR, T0 + 4 * HOUR + 3 * MIN, segments);
  eq(currentRunStartMs(segments, T0 + 4 * HOUR + 3 * MIN), T0 + 4 * HOUR);
  eq(currentRunStartMs([], T0), T0);
});

// ── Storage pressure ──
t('thinning never picks the first or last frame', () => {
  const frames = Array.from({ length: 10 }, (_, i) => T0 + i * 30_000);
  const victims = pickThinningVictims(frames, 8);
  ok(!victims.includes(0) && !victims.includes(9));
  eq(victims.length, 8);
});

t('repeated single drops spread out instead of eating the oldest end', () => {
  let frames = Array.from({ length: 41 }, (_, i) => T0 + i * 30_000);
  for (let round = 0; round < 20; round++) {
    const [victim] = pickThinningVictims(frames, 1);
    frames = frames.filter((_, i) => i !== victim);
  }
  const gaps = frames.slice(1).map((ms, i) => ms - frames[i]);
  ok(Math.max(...gaps) <= 60_000, `largest gap ${Math.max(...gaps)}ms — a hole was cut`);
  eq(frames[0], T0);
});

t('frames in the protected live window are never thinned', () => {
  const frames = Array.from({ length: 10 }, (_, i) => T0 + i * 30_000);
  const victims = pickThinningVictims(frames, 10, T0 + 4 * 30_000);
  ok(victims.every((index) => frames[index] < T0 + 4 * 30_000));
});

// ── Activity batch responses ──
t('per-row batch errors are keyed by clientActivityId', () => {
  const parsed = parseBatchErrors([
    'abc123: MONITORING_SESSION_NOT_ACTIVE: activity started after the session ended',
    'def456: MONITORING_INVALID_PERIOD: endedAt is before startedAt',
    'malformed line',
  ]);
  eq(parsed.size, 2);
  ok(parsed.get('abc123').startsWith('MONITORING_SESSION_NOT_ACTIVE'));
  ok(parsed.get('def456').startsWith('MONITORING_INVALID_PERIOD'));
  eq(parseBatchErrors(undefined).size, 0);
});

// ── Re-homing into a continuation session ──
t('an item moves to the successor only if the successor had begun', () => {
  const session = { successorId: 's2', successorStartedAtMs: T0 + HOUR };
  eq(successorFor(session, T0 + HOUR), 's2');
  eq(successorFor(session, T0 + 2 * HOUR), 's2');
  eq(successorFor(session, T0 + HOUR - 1), null);
  eq(successorFor(null, T0), null);
  eq(successorFor({ successorId: null, successorStartedAtMs: null }, T0), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
