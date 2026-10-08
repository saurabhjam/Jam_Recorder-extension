/**
 * Tests for what the toolbar icon is allowed to say.
 *
 * The property that must hold: MON appears only while monitoring is running on
 * this machine AND screenshots are actually arriving. Every other state — idle,
 * stopping, starting, paused, a dead agent, a failed capture, a session that
 * has gone quiet — gets something else, because a MON that outlives its
 * session is the one thing nobody checks and everybody believes.
 *
 * Run with `npm run test`.
 */

import { BADGE, badgeFor, captureGraceMs, sameBadge } from './.build/monitoringBadge.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };

const NOW = Date.parse('2026-09-29T09:00:00Z');
const SEC = 1000;

const base = {
  status: 'monitoring',
  captureStatus: 'capturing',
  agentStatus: 'monitoring',
  lastCaptureAtMs: NOW - 20 * SEC,
  intervalSeconds: 30,
  nowMs: NOW,
  recordingOwnsBadge: false,
};
const badge = (over = {}) => badgeFor({ ...base, ...over });

// ── MON means capturing ──
t('a healthy session shows MON', () => {
  eq(badge().text, BADGE.ACTIVE.text);
});

t('every state that is not a running session clears the badge', () => {
  for (const status of ['idle', 'stopping', 'error']) {
    eq(badge({ status }).text, '', `status ${status}`);
  }
});

t('a session being started shows nothing until the first frame lands', () => {
  eq(badge({ status: 'starting', lastCaptureAtMs: null }).text, '');
});

t('a paused session is not MON', () => {
  const view = badge({ status: 'paused' });
  eq(view.text, BADGE.PAUSED.text);
  ok(!view.text.includes('MON'));
});

// ── Running, but capturing nothing ──
t('no frame for two intervals is not MON', () => {
  const stale = badge({ lastCaptureAtMs: NOW - captureGraceMs(30) - SEC });
  eq(stale.text, BADGE.STALLED.text);
  ok(!stale.text.includes('MON'), 'a stalled session must not claim MON');
});

t('one late frame is tolerated, two are not', () => {
  eq(badge({ lastCaptureAtMs: NOW - 70 * SEC }).text, BADGE.ACTIVE.text);
  eq(badge({ lastCaptureAtMs: NOW - 10 * 60 * SEC }).text, BADGE.STALLED.text);
});

t('the grace follows the capture interval', () => {
  ok(captureGraceMs(60) > captureGraceMs(30));
  // Two intervals plus a minute: 180s on a 60s interval, 120s on a 30s one.
  eq(badge({ intervalSeconds: 60, lastCaptureAtMs: NOW - 150 * SEC }).text, BADGE.ACTIVE.text);
  eq(badge({ intervalSeconds: 30, lastCaptureAtMs: NOW - 150 * SEC }).text, BADGE.STALLED.text);
});

t('a dead, missing or unpermitted agent is never MON', () => {
  for (const agentStatus of [
    'disconnected',
    'unavailable',
    'permission-required',
    'unsupported-platform',
    'outdated',
    'error',
  ]) {
    eq(badge({ agentStatus }).text, BADGE.STALLED.text, `agent ${agentStatus}`);
  }
});

t('a failed or reconnecting capture is never MON', () => {
  for (const captureStatus of ['failed', 'reconnect', 'stopped']) {
    eq(badge({ captureStatus }).text, BADGE.STALLED.text, `capture ${captureStatus}`);
  }
});

t('a session that has never captured anything is not MON', () => {
  eq(badge({ lastCaptureAtMs: null }).text, BADGE.STALLED.text);
});

// ── Signed out, but still recording ──
t('a session with nobody signed in gets its own badge, not MON', () => {
  const view = badge({ signedOut: true });
  eq(view.text, BADGE.SIGNED_OUT.text);
  ok(!view.text.includes('MON'), 'a signed-out session must not look like a healthy one');
  ok(view.text.length <= 4, 'the toolbar shows about four characters');
});

t('signing in is said before a stalled capture, because only a person can do it', () => {
  eq(badge({ signedOut: true, captureStatus: 'failed' }).text, BADGE.SIGNED_OUT.text);
  eq(badge({ signedOut: true, agentStatus: 'disconnected' }).text, BADGE.SIGNED_OUT.text);
});

t('a paused session with nobody signed in says so too', () => {
  eq(badge({ signedOut: true, status: 'paused' }).text, BADGE.SIGNED_OUT.text);
});

t('being signed out means nothing when no session is running', () => {
  eq(badge({ signedOut: true, status: 'idle' }).text, '');
  eq(badge({ signedOut: true, recordingOwnsBadge: true }), null);
});

t('signed in is the ordinary case and is unaffected', () => {
  eq(badge({ signedOut: false }).text, BADGE.ACTIVE.text);
  eq(badge({}).text, BADGE.ACTIVE.text);
});

// ── Sharing the toolbar with a recording ──
t('a recording keeps the badge, and monitoring does not fight it', () => {
  eq(badge({ recordingOwnsBadge: true }), null);
  eq(badge({ status: 'idle', recordingOwnsBadge: true }), null);
});

// ── Only real changes are drawn ──
t('identical badges compare equal, and null only to null', () => {
  ok(sameBadge(BADGE.ACTIVE, { ...BADGE.ACTIVE }));
  ok(!sameBadge(BADGE.ACTIVE, BADGE.STALLED));
  ok(sameBadge(null, null));
  ok(!sameBadge(null, BADGE.NONE));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
