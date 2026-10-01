/**
 * Tests for the sign-in refresh policy.
 *
 * The property that must hold, whatever else changes: the extension signs
 * somebody out only when the sign-in server says their refresh token is no
 * longer valid. Every other failure — no network, a gateway error, a timeout,
 * a wrong client secret, losing the rotation race to another part of the
 * extension — keeps them signed in and retries, because being signed out stops
 * monitoring from uploading anything until a person notices.
 *
 * Run with `npm run test`.
 */

import {
  AUTH_POLICY,
  classifyRefreshFailure,
  isExpired,
  needsRefresh,
  refreshRetryDelayMs,
  supersededBy,
} from './.build/authRefreshPolicy.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };

const NOW = Date.parse('2026-09-29T09:00:00Z');
const MIN = 60_000;

// ── Only the server's own verdict signs anybody out ──
t('an unreachable sign-in server never signs anyone out', () => {
  for (const status of [0, 408, 500, 502, 503, 504]) {
    eq(classifyRefreshFailure({ status, body: '' }), 'retry', `status ${status}`);
  }
});

t('a gateway error page, with no OAuth answer in it, is retried', () => {
  eq(classifyRefreshFailure({ status: 502, body: '<html>Bad Gateway</html>' }), 'retry');
  eq(classifyRefreshFailure({ status: 404, body: 'Not Found' }), 'retry');
  // 401 at the token endpoint is also what wrong client credentials return, so
  // on its own it is not the person's sign-in being rejected.
  eq(classifyRefreshFailure({ status: 401, body: 'Unauthorized' }), 'retry');
});

t('invalid_grant is the one answer that signs someone out', () => {
  eq(classifyRefreshFailure({ status: 400, body: { error: 'invalid_grant' } }), 'invalid');
  eq(classifyRefreshFailure({ status: 400, body: 'error=invalid_grant' }), 'invalid');
  eq(classifyRefreshFailure({ status: 401, body: { error: 'invalid_token' } }), 'invalid');
  eq(
    classifyRefreshFailure({ status: 400, body: { error_description: 'Refresh token is expired' } }),
    'invalid',
  );
});

// ── Losing the rotation race is not being signed out ──
t('a token another part of the extension already published is used instead', () => {
  const attempted = { refreshToken: 'r1' };
  const stored = { refreshToken: 'r2', accessToken: 'a2', expiresAt: NOW + 30 * MIN };
  eq(supersededBy(attempted, stored, NOW), 'a2');
});

t('the same token coming back is not a supersession', () => {
  const attempted = { refreshToken: 'r1' };
  eq(supersededBy(attempted, { refreshToken: 'r1', accessToken: 'a1', expiresAt: NOW + MIN }, NOW), null);
  eq(supersededBy(attempted, null, NOW), null);
  eq(supersededBy(null, { refreshToken: 'r2', accessToken: 'a2', expiresAt: NOW + MIN }, NOW), null);
});

t('a newer token that is itself already expired is no help', () => {
  const attempted = { refreshToken: 'r1' };
  const stale = { refreshToken: 'r2', accessToken: 'a2', expiresAt: NOW - MIN };
  eq(supersededBy(attempted, stale, NOW), null);
});

// ── Refreshing early, and often enough ──
t('a token is refreshed before it expires, not after', () => {
  ok(!needsRefresh(NOW + 30 * MIN, NOW), 'half an hour left is not due');
  ok(needsRefresh(NOW + 9 * MIN, NOW), 'nine minutes left is due');
  ok(needsRefresh(NOW - MIN, NOW), 'already expired is due');
  ok(needsRefresh(undefined, NOW), 'an unknown expiry is due');
});

t('the periodic check is frequent enough to catch the buffer', () => {
  ok(AUTH_POLICY.CHECK_INTERVAL_MINUTES * MIN < AUTH_POLICY.REFRESH_BUFFER_MS,
    'a token could expire between two checks');
});

t('an expired token is known to be unusable', () => {
  ok(isExpired(NOW - 1, NOW));
  ok(isExpired(NOW + 5_000, NOW), 'within the slack counts as expired');
  ok(!isExpired(NOW + 60_000, NOW));
});

t('retries back off, and cap', () => {
  const delays = [1, 2, 3, 4, 5, 20].map(refreshRetryDelayMs);
  for (let i = 1; i < delays.length; i++) ok(delays[i] >= delays[i - 1], 'backoff went backwards');
  eq(delays.at(-1), AUTH_POLICY.RETRY_BACKOFF_MS.at(-1));
  ok(delays[0] <= 30_000, 'the first retry is not prompt');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
