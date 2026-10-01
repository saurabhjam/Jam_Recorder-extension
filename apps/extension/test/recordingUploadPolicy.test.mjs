/**
 * Tests for the recording-upload rules.
 *
 * The property that must hold, whatever else changes: a finished recording is
 * never lost. The local file may be deleted at exactly one moment — after the
 * server has confirmed it holds both the video and its record — and every
 * failure short of that is a delay, not an ending.
 *
 * Run with `npm run test`.
 */

import {
  UPLOAD_POLICY,
  canDeleteLocal,
  classifyUploadFailure,
  describeStage,
  dueJobs,
  isFullClip,
  isWornOut,
  needsReencode,
  uploadRetryDelayMs,
} from './.build/recordingUploadPolicy.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };

const NOW = Date.parse('2026-10-01T09:00:00Z');
const MIN = 60_000;
const job = (over = {}) => ({
  recordingId: 'r1',
  uploadId: 'up-1',
  stage: 'pending',
  attempts: 0,
  createdAt: NOW,
  nextAttemptAt: NOW,
  videoFileName: null,
  backendRecordId: null,
  ...over,
});

// ── The one rule that deletes a video ──
t('the local file may only go once the server confirms both parts', () => {
  ok(canDeleteLocal(job({ stage: 'confirmed', backendRecordId: 'rec-1' })));
  ok(!canDeleteLocal(job({ stage: 'confirmed', backendRecordId: null })), 'no record, no deletion');
  for (const stage of ['saved', 'processing', 'pending', 'uploading', 'uploaded', 'paused']) {
    ok(!canDeleteLocal(job({ stage, backendRecordId: 'rec-1' })), `deleted while ${stage}`);
  }
});

// ── No failure is permanent except a verdict on the content ──
t('a server that is down or unreachable is always retried', () => {
  for (const status of [0, 408, 425, 429, 500, 502, 503, 504]) {
    eq(classifyUploadFailure({ status }), 'retry', `status ${status}`);
  }
});

t('a lapsed sign-in waits for the sign-in, it does not fail the upload', () => {
  eq(classifyUploadFailure({ status: 401 }), 'auth');
  eq(classifyUploadFailure({ status: 403 }), 'auth');
});

t('"too large" is retried — an operator can raise the limit', () => {
  eq(classifyUploadFailure({ status: 413 }), 'retry');
});

t('only a real refusal of the content stops the automatic retries', () => {
  eq(classifyUploadFailure({ status: 400 }), 'fatal');
  eq(classifyUploadFailure({ status: 422 }), 'fatal');
});

t('retries back off and cap at ten minutes', () => {
  const delays = [1, 2, 3, 4, 5, 6, 12].map((n) => uploadRetryDelayMs(n, () => 0.5));
  for (let i = 1; i < delays.length; i++) ok(delays[i] >= delays[i - 1], 'backoff went backwards');
  eq(delays.at(-1), UPLOAD_POLICY.RETRY_BACKOFF_MS.at(-1));
  ok(delays[0] <= 20_000, 'the first retry is not prompt');
});

t('jitter keeps a roomful of clients from retrying in lockstep', () => {
  const low = uploadRetryDelayMs(3, () => 0);
  const high = uploadRetryDelayMs(3, () => 1);
  ok(high > low, 'no spread at all');
});

// ── What gets attempted, and when ──
t('confirmed and paused jobs are left alone; the rest go oldest first', () => {
  const jobs = [
    job({ recordingId: 'new', createdAt: NOW }),
    job({ recordingId: 'old', createdAt: NOW - 10 * MIN }),
    job({ recordingId: 'done', stage: 'confirmed' }),
    job({ recordingId: 'stopped', stage: 'paused' }),
    job({ recordingId: 'later', nextAttemptAt: NOW + MIN }),
  ];
  eq(dueJobs(jobs, NOW).map((j) => j.recordingId), ['old', 'new']);
});

t('a job is given up on only after two weeks — and even then it is kept', () => {
  ok(!isWornOut(job({ createdAt: NOW - 13 * 24 * 3_600_000 }), NOW));
  ok(isWornOut(job({ createdAt: NOW - 15 * 24 * 3_600_000 }), NOW));
  // "Worn out" means paused, and a paused job still forbids deletion.
  ok(!canDeleteLocal(job({ stage: 'paused', backendRecordId: 'rec-1' })));
});

// ── Trimming only when it would change something ──
t('saving an untouched recording never re-encodes', () => {
  ok(!needsReencode({
    trimStart: 0, trimEnd: 1, muteMic: false, muteSystem: false,
    audioMixed: true, hasMicTrack: true, durationSeconds: 600,
  }));
});

t('a dragged handle that lands back at the ends still counts as the full clip', () => {
  ok(isFullClip(0.004, 0.996));
  ok(!isFullClip(0.02, 1));
  ok(!needsReencode({
    trimStart: 0.004, trimEnd: 0.997, muteMic: false, muteSystem: false,
    audioMixed: true, hasMicTrack: false, durationSeconds: 60,
  }));
});

t('an actual trim does re-encode', () => {
  ok(needsReencode({
    trimStart: 0.1, trimEnd: 0.8, muteMic: false, muteSystem: false,
    audioMixed: true, hasMicTrack: false, durationSeconds: 60,
  }));
});

t('muting a source on a mixed recording re-encodes; nothing else does', () => {
  const base = {
    trimStart: 0, trimEnd: 1, audioMixed: true, hasMicTrack: true, durationSeconds: 60,
  };
  ok(needsReencode({ ...base, muteMic: true, muteSystem: false }));
  ok(needsReencode({ ...base, muteMic: false, muteSystem: true }));
  ok(!needsReencode({ ...base, muteMic: false, muteSystem: false }));
});

t('an older recording folds its separate mic track in, but only if there is one', () => {
  const base = {
    trimStart: 0, trimEnd: 1, muteMic: false, muteSystem: false,
    audioMixed: false, durationSeconds: 60,
  };
  ok(needsReencode({ ...base, hasMicTrack: true }), 'the mic would be lost');
  ok(!needsReencode({ ...base, hasMicTrack: false }), 'nothing to fold in');
});

t('a recording of unknown length is never re-encoded', () => {
  ok(!needsReencode({
    trimStart: 0.2, trimEnd: 0.9, muteMic: true, muteSystem: true,
    audioMixed: false, hasMicTrack: true, durationSeconds: 0,
  }));
});

// ── The trim has a deadline proportional to the clip ──
t('the trim budget follows the length of the clip, with a floor', () => {
  ok(UPLOAD_POLICY.TRIM_BUDGET_MS(0) >= 60_000, 'a short clip still gets a minute');
  ok(UPLOAD_POLICY.TRIM_BUDGET_MS(600) > UPLOAD_POLICY.TRIM_BUDGET_MS(60));
  // Re-encoding runs in real time, so the budget must exceed the clip itself.
  ok(UPLOAD_POLICY.TRIM_BUDGET_MS(600) > 600_000);
});

// ── What the person is told ──
t('no stage is ever described as lost, and pending reads as temporary', () => {
  for (const stage of ['saved', 'processing', 'pending', 'uploading', 'uploaded', 'confirmed', 'paused']) {
    const text = describeStage(job({ stage }));
    ok(text.length > 0, stage);
    ok(!/fail|lost|error/i.test(text), `"${text}" sounds like a loss`);
  }
  ok(/retry|by itself/i.test(describeStage(job({ stage: 'pending' }))));
  ok(/connection/i.test(describeStage(job({ stage: 'pending' }), false)));
  ok(/saved on this computer/i.test(describeStage(job({ stage: 'paused' }))));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
