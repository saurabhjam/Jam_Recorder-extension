/**
 * Tests for when a sign-in ends on purpose.
 *
 * The properties that must hold: everybody is asked to sign in once a day, the
 * asking happens at night rather than in the middle of someone's work, and
 * nobody is signed out moments after signing in. Being signed out for any other
 * reason is a bug and belongs to authRefreshPolicy.
 *
 * Run with `npm run test`.
 */

import {
  SESSION_POLICY,
  describeSignOut,
  lastNightlyBoundary,
  sessionSignOutReason,
} from './.build/sessionLifetime.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };

/** Local time, so the test reads the way the policy is written. */
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── The boundary ──
t('the boundary is this morning once it has passed, yesterday before that', () => {
  eq(lastNightlyBoundary(at(6, 9, 30)), at(6, 2), 'mid-morning should look back to 2am today');
  eq(lastNightlyBoundary(at(6, 1, 30)), at(5, 2), 'half past one belongs to yesterday');
  eq(lastNightlyBoundary(at(6, 2, 0)), at(6, 2), 'exactly 2am is today');
});

// ── A day's work ──
t('signing in at nine and working all day is never interrupted', () => {
  const signedInAt = at(6, 9);
  for (const hour of [9, 12, 15, 18, 21, 23]) {
    eq(sessionSignOutReason({ signedInAt, nowMs: at(6, hour) }), null, `at ${hour}:00`);
  }
});

t('an evening shift running past midnight is left alone until two', () => {
  const signedInAt = at(6, 20);
  eq(sessionSignOutReason({ signedInAt, nowMs: at(7, 0, 30) }), null, 'half past midnight');
  eq(sessionSignOutReason({ signedInAt, nowMs: at(7, 1, 59) }), null, 'one minute to two');
  eq(sessionSignOutReason({ signedInAt, nowMs: at(7, 2, 1) }), 'nightly', 'just past two');
});

t('somebody who signs in during the small hours is not signed straight out', () => {
  const signedInAt = at(7, 2, 30);
  eq(sessionSignOutReason({ signedInAt, nowMs: at(7, 2, 35) }), null, 'five minutes later');
  eq(sessionSignOutReason({ signedInAt, nowMs: at(7, 9) }), null, 'that same morning');
  eq(sessionSignOutReason({ signedInAt, nowMs: at(8, 2, 1) }), 'nightly', 'the next night');
});

// ── A machine that was asleep at two ──
t('a laptop switched off overnight is signed out when it is next used', () => {
  // Signed in Monday morning, machine off from the evening, opened Tuesday at 9.
  eq(sessionSignOutReason({ signedInAt: at(6, 9), nowMs: at(7, 9) }), 'nightly');
});

t('a long weekend still only needs one sign-in on return', () => {
  eq(sessionSignOutReason({ signedInAt: at(2, 9), nowMs: at(5, 9) }), 'nightly');
});

// ── The ceiling ──
t('no sign-in outlives the maximum age', () => {
  const signedInAt = at(1, 9);
  eq(sessionSignOutReason({ signedInAt, nowMs: signedInAt + SESSION_POLICY.MAX_AGE_MS }), 'max-age');
  // The nightly rule normally gets there first; the ceiling is the backstop.
  eq(
    sessionSignOutReason({ signedInAt, nowMs: signedInAt + 8 * DAY, nightlyHour: 2 }),
    'max-age',
  );
});

t('the ceiling is a week, not a day', () => {
  eq(SESSION_POLICY.MAX_AGE_MS, 7 * DAY);
});

// ── Nothing else signs anybody out ──
t('an unknown or future sign-in time is never a reason to sign out', () => {
  eq(sessionSignOutReason({ signedInAt: null, nowMs: at(6, 9) }), null);
  eq(sessionSignOutReason({ signedInAt: Number.NaN, nowMs: at(6, 9) }), null);
  // A clock that jumped backwards: not the person's fault.
  eq(sessionSignOutReason({ signedInAt: at(8, 9), nowMs: at(6, 9) }), null);
});

t('the boundary hour can be moved without touching anything else', () => {
  const signedInAt = at(6, 20);
  eq(sessionSignOutReason({ signedInAt, nowMs: at(7, 3, 30), nightlyHour: 4 }), null);
  eq(sessionSignOutReason({ signedInAt, nowMs: at(7, 4, 30), nightlyHour: 4 }), 'nightly');
});

// ── What people are told ──
t('both messages say monitoring kept running and nothing was lost', () => {
  for (const reason of ['nightly', 'max-age']) {
    const text = describeSignOut(reason);
    ok(/nothing was lost/i.test(text), text);
    ok(/sign in/i.test(text), text);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
