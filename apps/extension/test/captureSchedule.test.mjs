/**
 * Tests for the monitoring capture scheduler.
 *
 * The one property that must hold: a chosen interval produces captures on a
 * fixed grid regardless of how long each capture and upload takes. Screenshots
 * silently arriving every 65 seconds instead of every 60 — or stopping
 * altogether while an upload is slow — is the failure mode this guards.
 *
 * Run with `npm run test` (which compiles the TypeScript source first, so these
 * exercise the real module rather than a copy).
 */

import {
  nextDeadline,
  advanceDeadline,
  isCaptureOverdue,
  simulateSchedule,
} from './.build/captureSchedule.js';
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };

const T0 = Date.parse('2026-09-04T10:00:00Z');
const MIN = 60_000;

// ── §7: 60s interval lands on the grid ──
t('first deadline is one interval out', () => {
  const d = nextDeadline(0, MIN, T0);
  eq(d.nextCaptureAt, T0 + MIN);
  eq(d.delayMs, MIN);
  eq(d.missedDeadlines, 0);
});

t('60s grid: 10:01, 10:02, 10:03 …', () => {
  const fired = simulateSchedule(T0, MIN, [0, 0, 0, 0]);
  eq(fired.map(ms => new Date(ms).toISOString()), [
    '2026-09-04T10:01:00.000Z','2026-09-04T10:02:00.000Z',
    '2026-09-04T10:03:00.000Z','2026-09-04T10:04:00.000Z']);
});

t('30s grid stays on 30s boundaries', () => {
  const fired = simulateSchedule(T0, 30_000, [0,0,0,0,0,0]);
  eq(fired.map(ms => (ms - T0) / 1000), [30,60,90,120,150,180]);
});

// ── §47 Test 3: slow uploads must NOT drift the schedule ──
t('a 5s capture+upload does not shift a 60s schedule', () => {
  const fired = simulateSchedule(T0, MIN, [5000,5000,5000,5000,5000]);
  eq(fired.map(ms => (ms - T0) / 1000), [60,120,180,240,300],
     'latency leaked into the cadence');
});

t('a 25s capture+upload still does not shift a 30s schedule', () => {
  const fired = simulateSchedule(T0, 30_000, [25000,25000,25000,25000]);
  eq(fired.map(ms => (ms - T0) / 1000), [30,60,90,120]);
});

// ── §8: an overrunning capture skips, never overlaps or drifts cumulatively ──
t('a capture overrunning its slot skips to the next grid point', () => {
  // 90s of work inside a 60s interval: the 10:02 deadline is already past when
  // the 10:01 capture finishes, so it is skipped and 10:03 fires next.
  const fired = simulateSchedule(T0, MIN, [90_000, 0, 0]);
  eq(fired.map(ms => (ms - T0) / 1000), [60, 180, 240]);
});

t('skipped deadlines are counted, and stay on the grid', () => {
  // Asleep from 10:00:30 to 10:05:10.
  const woke = T0 + 5 * MIN + 10_000;
  const d = nextDeadline(T0 + MIN, MIN, woke);
  eq(new Date(d.nextCaptureAt).toISOString(), '2026-09-04T10:06:00.000Z');
  eq(d.missedDeadlines, 4);
});

t('no burst after a long sleep — one future deadline, not a backlog', () => {
  const d = nextDeadline(T0 + MIN, MIN, T0 + 60 * MIN);
  if (d.delayMs <= 0) throw new Error('would fire immediately');
  if (d.delayMs > MIN) throw new Error(`delay ${d.delayMs} exceeds one interval`);
});

t('advanceDeadline is exactly one interval', () => {
  eq(advanceDeadline(T0, MIN), T0 + MIN);
});

t('a deadline exactly at now advances rather than firing twice', () => {
  const d = nextDeadline(T0, MIN, T0);
  eq(d.nextCaptureAt, T0 + MIN);
  eq(d.missedDeadlines, 0);
});

// ── §12 watchdog ──
t('overdue only after two intervals plus slack', () => {
  eq(isCaptureOverdue(T0, MIN, T0 + 2 * MIN), false);
  eq(isCaptureOverdue(T0, MIN, T0 + 2 * MIN + 61_000), true);
  eq(isCaptureOverdue(null, MIN, T0 + 10 * MIN), false, 'no capture yet is not overdue');
});

t('rejects a nonsense interval instead of scheduling garbage', () => {
  let threw = false;
  try { nextDeadline(0, 0, T0); } catch { threw = true; }
  if (!threw) throw new Error('accepted intervalMs=0');
});

// ── Drift over a long run: the real regression test ──
t('3 minutes at 30s with variable latency stays exactly on the grid', () => {
  const durations = [1000, 12000, 3000, 28000, 500, 9000];
  const fired = simulateSchedule(T0, 30_000, durations);
  fired.forEach((ms) => {
    if ((ms - T0) % 30_000 !== 0) throw new Error(`${new Date(ms).toISOString()} is off-grid`);
  });
});

t('5 minutes at 60s stays exactly on the grid', () => {
  const fired = simulateSchedule(T0, MIN, [2000, 45000, 1000, 8000, 3000]);
  eq(fired.map(ms => (ms - T0) / 1000), [60,120,180,240,300]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
