/**
 * How long a sign-in lasts, and when everyone is asked for it again.
 *
 * Two separate things, often confused:
 *
 *  - Being signed out because something went wrong. That is a bug, and the
 *    refresh policy (see authRefreshPolicy.ts) exists to make sure it only ever
 *    happens when the server genuinely rejects the sign-in.
 *  - Being signed out because it is policy. That is this file: a deliberate
 *    sign-out in the small hours so each day starts with somebody actually
 *    signing in, plus a hard ceiling on how long any one sign-in may live.
 *
 * The distinction matters to the person using it. The first is an interruption
 * they cannot predict; the second happens overnight, when nobody is working,
 * and monitoring carries on regardless — it keeps recording and keeps what it
 * records, it simply cannot upload until somebody signs in.
 */

export const SESSION_POLICY = {
  /**
   * Hour of the local night the sign-in is ended, 24-hour clock.
   *
   * Two in the morning: late enough that an evening shift has finished, early
   * enough that nobody is at their desk, and far from the start of any working
   * day. The sign-out is dated to this boundary rather than fired inside a
   * window, so a machine that was switched off at 2am is signed out the moment
   * it is next used — which is the morning, which is the point.
   */
  NIGHTLY_HOUR: 2,

  /**
   * The longest any sign-in may live, whatever else happens.
   *
   * A backstop for the nightly rule, not the everyday path: a machine that is
   * never awake at the boundary, a clock that moves, a future where the nightly
   * sign-out is turned off.
   */
  MAX_AGE_MS: 7 * 24 * 3_600_000,
} as const;

export type SignOutReason = 'nightly' | 'max-age';

/**
 * The most recent moment the nightly boundary passed, in local time.
 *
 * Returns today's boundary when it has already passed, otherwise yesterday's.
 * Local on purpose: "two in the morning" means two in the morning where the
 * person is, and a team spread across timezones each gets their own night.
 */
export function lastNightlyBoundary(
  nowMs: number,
  hour: number = SESSION_POLICY.NIGHTLY_HOUR,
): number {
  const now = new Date(nowMs);
  const boundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (boundary.getTime() > nowMs) boundary.setDate(boundary.getDate() - 1);
  return boundary.getTime();
}

/**
 * Should this sign-in be ended, and why?
 *
 * `null` means leave it alone. A sign-in that began after the last boundary is
 * left alone until the next one — somebody who signs in at half past two is not
 * signed straight back out.
 */
export function sessionSignOutReason(session: {
  /** When this sign-in began. */
  signedInAt: number | null;
  nowMs: number;
  nightlyHour?: number;
  maxAgeMs?: number;
}): SignOutReason | null {
  const { signedInAt, nowMs } = session;
  if (signedInAt == null || !Number.isFinite(signedInAt)) return null;
  // A sign-in dated in the future is a clock that has moved, not a reason to
  // throw somebody out.
  if (signedInAt > nowMs) return null;

  const maxAge = session.maxAgeMs ?? SESSION_POLICY.MAX_AGE_MS;
  if (nowMs - signedInAt >= maxAge) return 'max-age';

  const boundary = lastNightlyBoundary(nowMs, session.nightlyHour ?? SESSION_POLICY.NIGHTLY_HOUR);
  if (signedInAt < boundary) return 'nightly';
  return null;
}

/** What to tell somebody who finds themselves signed out. */
export function describeSignOut(reason: SignOutReason): string {
  return reason === 'nightly'
    ? 'Signed out overnight, as scheduled. Sign in to continue — monitoring kept running and nothing was lost.'
    : 'This sign-in reached its age limit. Sign in to continue — monitoring kept running and nothing was lost.';
}
