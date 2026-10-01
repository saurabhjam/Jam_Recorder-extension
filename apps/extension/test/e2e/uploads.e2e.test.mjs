/**
 * The recording upload queue, end to end.
 *
 * The real background queue is bundled and driven here — only its surroundings
 * are simulated: chrome.storage, chrome.alarms, the clock, the network, and the
 * offscreen document that pushes the bytes. The scenarios are the ways a save
 * goes wrong in the field, and every one of them asserts the same thing in the
 * end: the video is still here, and it gets to the server.
 *
 * Run with `npm run test`.
 */

import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, mkdirSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

// ─── Bundle the real queue ────────────────────────────────────────────────────

const outDir = resolve(here, '..', '.build');
mkdirSync(outDir, { recursive: true });
const bundlePath = resolve(outDir, 'uploads.e2e.bundle.mjs');

await esbuild.build({
  entryPoints: [resolve(root, 'src', 'background', 'recordings.uploader.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: bundlePath,
  logLevel: 'error',
  define: { 'import.meta.env': JSON.stringify({ VITE_API_BASE_URL: 'http://api.test' }) },
  plugins: [
    {
      name: 'at-alias',
      setup(build) {
        build.onResolve({ filter: /^@\// }, async (args) => {
          const base = resolve(root, 'src', args.path.slice(2));
          for (const ext of ['.ts', '.tsx', '/index.ts']) {
            if (existsSync(base + ext)) return { path: base + ext };
          }
          return { path: base };
        });
      },
    },
  ],
});

// ─── Clock ────────────────────────────────────────────────────────────────────

const RealDate = Date;
const T0 = RealDate.parse('2026-10-01T09:00:00.000Z');
let NOW = T0;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FakeDate;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

// ─── The world around the queue ───────────────────────────────────────────────

let scenarioCount = 0;

async function environment() {
  const env = {
    store: new Map(),
    alarms: new Map(),
    /** Files on disk, by id. Deleting one is what "losing the video" means. */
    disk: new Map([['rec-1', 12_345_678]]),
    online: true,
    /** What the fake server does to the next attempt. */
    failWith: null,
    /** Records created, by shareId — a second one is a duplicate. */
    records: new Map(),
    /** Every time the bytes were actually sent. */
    uploads: [],
    nextRecordId: 1,
    /** Set when the server answered but the answer never reached us. */
    loseAnswer: false,
  };

  globalThis.chrome = {
    runtime: { id: 'test', sendMessage: () => Promise.resolve(), lastError: undefined },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const key of [].concat(keys ?? [])) {
            if (env.store.has(key)) out[key] = structuredClone(env.store.get(key));
          }
          return out;
        },
        set: async (items) => {
          for (const [k, v] of Object.entries(items)) env.store.set(k, structuredClone(v));
        },
        remove: async (keys) => {
          for (const key of [].concat(keys)) env.store.delete(key);
        },
      },
    },
    alarms: {
      create: async (name, options) => void env.alarms.set(name, options),
      clear: async (name) => env.alarms.delete(name),
      get: async (name) => (env.alarms.has(name) ? { name, ...env.alarms.get(name) } : undefined),
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { get onLine() { return env.online; } },
    configurable: true,
    writable: true,
  });

  env.worker = await import(`${pathToFileURL(bundlePath).href}?scenario=${++scenarioCount}`);

  /** The offscreen document: reads the file, sends it, creates the record. */
  const attempt = async (job) => {
    const fail = (message, status, partial = {}) => {
      const err = new env.worker.UploadAttemptError(message, status, partial);
      throw err;
    };
    if (!env.online) fail('Network error', 0);
    if (env.failWith) {
      const { status, message, afterBytes } = env.failWith;
      if (!afterBytes) fail(message ?? 'refused', status);
      // Failed after the bytes landed: the file name comes back so the retry
      // does not send them again.
      const name = job.videoFileName ?? storeBytes(job);
      fail(message ?? 'refused', status, { videoFileName: name });
    }

    const videoFileName = job.videoFileName ?? storeBytes(job);
    if (job.backendRecordId) {
      return { videoFileName, backendRecordId: job.backendRecordId };
    }
    const existing = env.records.get(job.uploadId);
    const backendRecordId = existing ?? `rec-${env.nextRecordId++}`;
    env.records.set(job.uploadId, backendRecordId);
    if (env.loseAnswer) {
      env.loseAnswer = false;
      fail('The answer never came back', 0, { videoFileName });
    }
    return { videoFileName, backendRecordId };
  };

  const storeBytes = (job) => {
    const source = job.exportId && env.disk.has(job.exportId) ? job.exportId : job.recordingId;
    if (!env.disk.has(source)) {
      const err = new env.worker.UploadAttemptError('file is gone', 410);
      throw err;
    }
    env.uploads.push({ recordingId: job.recordingId, source, at: NOW });
    return `stored-${job.recordingId}-${env.uploads.length}`;
  };

  env.worker.configureUploader({
    attempt,
    discardLocal: async (recordingId, exportId) => {
      env.disk.delete(recordingId);
      if (exportId) env.disk.delete(exportId);
    },
  });

  env.jobs = () => env.worker.listUploadJobs();
  env.job = async (id = 'rec-1') => (await env.jobs()).find((j) => j.recordingId === id);

  /** Let `ms` pass, firing the upload alarm each minute as Chrome would. */
  env.advance = async (ms) => {
    const end = NOW + ms;
    while (NOW < end) {
      NOW = Math.min(NOW + MIN, end);
      if (env.alarms.has('bestq-recording-upload')) {
        await env.worker.handleRecordingUploadAlarm();
        await settle();
      }
    }
    await settle();
  };

  /** The worker is torn down and started again — a crash, or an update. */
  env.restart = async () => {
    env.worker = await import(`${pathToFileURL(bundlePath).href}?scenario=${++scenarioCount}`);
    env.worker.configureUploader({
      attempt,
      discardLocal: async (recordingId, exportId) => {
        env.disk.delete(recordingId);
        if (exportId) env.disk.delete(exportId);
      },
    });
    await env.worker.restoreRecordingUploads();
    await settle();
  };

  return env;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
async function scenario(name, run) {
  NOW = T0;
  try {
    await run();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`);
  }
}
const ok = (cond, message) => { if (!cond) throw new Error(message ?? 'expected true'); };

// ─── The ordinary case ────────────────────────────────────────────────────────

await scenario('a save that works: uploaded, confirmed, and only then is the file reclaimed', async () => {
  const env = await environment();
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  ok(env.disk.has('rec-1'), 'the file went before it was uploaded');
  await env.advance(2 * MIN);
  const job = await env.job();
  ok(job.stage === 'confirmed', `stage ${job.stage}`);
  ok(job.backendRecordId, 'no record was created');
  ok(!env.disk.has('rec-1'), 'the local copy was never reclaimed');
  ok(env.uploads.length === 1, `${env.uploads.length} uploads of the same video`);
});

// ─── The server is down ───────────────────────────────────────────────────────

await scenario('server down for an hour → pending, retried, and uploaded when it returns', async () => {
  const env = await environment();
  env.failWith = { status: 503, message: 'Service Unavailable' };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(60 * MIN);

  let job = await env.job();
  ok(job.stage === 'pending', `stage ${job.stage} while the server is down`);
  ok(job.attempts >= 3, `only ${job.attempts} attempts in an hour`);
  ok(env.disk.has('rec-1'), 'the video was deleted while the server was down');
  ok(env.records.size === 0, 'a record appeared on a server that was down');

  env.failWith = null;
  await env.advance(20 * MIN);
  job = await env.job();
  ok(job.stage === 'confirmed', `stage ${job.stage} after the server came back`);
  ok(!env.disk.has('rec-1'), 'the file should be reclaimed once confirmed');
});

await scenario('offline for two hours → nothing is attempted, nothing is lost', async () => {
  const env = await environment();
  env.online = false;
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(2 * HOUR);
  ok(env.disk.has('rec-1'), 'the video went while the machine was offline');
  ok((await env.job()).stage !== 'confirmed', 'confirmed with no network');

  env.online = true;
  await env.worker.notifyUploadsOnline();
  await settle();
  await env.advance(2 * MIN);
  ok((await env.job()).stage === 'confirmed', 'it did not upload on reconnect');
});

// ─── The sign-in ──────────────────────────────────────────────────────────────

await scenario('the sign-in lapses mid-upload → waits for it, never gives up, never deletes', async () => {
  const env = await environment();
  env.failWith = { status: 401, message: 'Unauthorized' };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(45 * MIN);
  const job = await env.job();
  ok(job.stage === 'pending', `stage ${job.stage}`);
  ok(job.lastErrorKind === 'auth', `kind ${job.lastErrorKind}`);
  ok(env.disk.has('rec-1'), 'the video was deleted over a sign-in');

  env.failWith = null; // the person signs in again
  await env.advance(20 * MIN);
  ok((await env.job()).stage === 'confirmed');
});

// ─── Crashes and restarts ─────────────────────────────────────────────────────

await scenario('the worker dies mid-upload → the restart finishes it without re-sending the video', async () => {
  const env = await environment();
  env.failWith = { status: 500, afterBytes: true }; // bytes land, the record does not
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(2 * MIN);
  const midway = await env.job();
  ok(midway.videoFileName, 'the stored file name was not remembered');
  ok(!midway.backendRecordId, 'a record exists already');
  ok(env.uploads.length === 1, `${env.uploads.length} uploads before the crash`);

  await env.restart();
  env.failWith = null;
  await env.advance(20 * MIN);

  const job = await env.job();
  ok(job.stage === 'confirmed', `stage ${job.stage} after the restart`);
  ok(env.uploads.length === 1, `the video was uploaded ${env.uploads.length} times`);
  ok(!env.disk.has('rec-1'));
});

await scenario('a job left mid-attempt by a torn-down worker is picked up again', async () => {
  const env = await environment();
  env.failWith = { status: 0, message: 'Network error' };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(MIN);
  // Pretend the worker died exactly while attempting: the stage stays 'uploading'.
  const jobs = await env.jobs();
  env.store.set(
    'st_upload_jobs',
    jobs.map((j) => ({ ...j, stage: 'uploading' })),
  );
  env.failWith = null;

  await env.restart();
  await env.advance(2 * MIN);
  ok((await env.job()).stage === 'confirmed', 'a stuck "uploading" job was never revived');
});

// ─── Duplicates ───────────────────────────────────────────────────────────────

await scenario('an answer lost on the way back does not create a second recording', async () => {
  const env = await environment();
  env.loseAnswer = true;
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(20 * MIN);
  ok((await env.job()).stage === 'confirmed', 'never finished');
  ok(env.records.size === 1, `${env.records.size} records for one recording`);
  ok(env.uploads.length === 1, `${env.uploads.length} uploads for one recording`);
});

await scenario('saving the same recording twice keeps one job and one upload', async () => {
  const env = await environment();
  env.failWith = { status: 503 };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(2 * MIN);
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p', title: 'Again' });
  env.failWith = null;
  await env.advance(5 * MIN);
  const jobs = await env.jobs();
  ok(jobs.length === 1, `${jobs.length} jobs for one recording`);
  ok(env.records.size === 1, `${env.records.size} records`);
  ok(jobs[0].title === 'Again', 'the second save’s choices were dropped');
});

await scenario('the editor dies after the record exists → the queue finishes it, not duplicates it', async () => {
  const env = await environment();
  // What the editor writes down as each phase lands, before it disappears.
  await env.worker.enqueueRecordingUpload({
    recordingId: 'rec-1',
    project: 'p',
    videoFileName: 'stored-by-the-editor',
    backendRecordId: 'rec-created-by-the-editor',
  });
  await env.advance(2 * MIN);
  const job = await env.job();
  ok(job.stage === 'confirmed', `stage ${job.stage}`);
  ok(job.backendRecordId === 'rec-created-by-the-editor', 'it replaced the record');
  ok(env.uploads.length === 0, 'the video was sent again although the server had it');
  ok(env.records.size === 0, 'a second record was created');
  ok(!env.disk.has('rec-1'), 'the local copy should be reclaimed');
});

// ─── Giving up, without losing anything ───────────────────────────────────────

await scenario('a server that refuses the content stops the retries but keeps the video', async () => {
  const env = await environment();
  env.failWith = { status: 400, message: 'Bad Request' };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(10 * MIN);
  const job = await env.job();
  ok(job.stage === 'paused', `stage ${job.stage}`);
  ok(env.disk.has('rec-1'), 'the video was deleted after a refusal');
  ok(job.attempts === 1, `it kept retrying a permanent refusal (${job.attempts})`);

  // The person retries by hand once the operator has fixed it.
  env.failWith = null;
  await env.worker.resumeRecordingUpload('rec-1');
  await env.advance(2 * MIN);
  ok((await env.job()).stage === 'confirmed', 'a manual retry did not work');
});

await scenario('two weeks of failure pauses the job and still keeps the video', async () => {
  const env = await environment();
  env.failWith = { status: 503 };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  for (let day = 0; day < 15; day++) await env.advance(24 * HOUR);
  const job = await env.job();
  ok(job.stage === 'paused', `stage ${job.stage}`);
  ok(env.disk.has('rec-1'), 'the video was deleted after two weeks of trying');
});

// ─── A window is still using the file ─────────────────────────────────────────

await scenario('an editor showing the recording keeps its file through the upload', async () => {
  const env = await environment();
  await env.worker.holdLocalCopy('rec-1'); // the editor opens
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(2 * MIN);

  const job = await env.job();
  ok(job.stage === 'confirmed', `stage ${job.stage}`);
  ok(job.pendingDiscard === true, 'the reclaim was not deferred');
  ok(env.disk.has('rec-1'), 'the file was pulled out from under the player');

  await env.worker.releaseLocalCopy('rec-1'); // the editor closes
  await settle();
  ok(!env.disk.has('rec-1'), 'the file was never reclaimed afterwards');
});

await scenario('a held file is reclaimed after a restart, once nothing holds it', async () => {
  const env = await environment();
  await env.worker.holdLocalCopy('rec-1');
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(2 * MIN);
  ok(env.disk.has('rec-1'), 'reclaimed while held');

  // The browser closes with the editor open: the hold lapses with it.
  env.store.set('st_upload_holds', { 'rec-1': NOW - 1 });
  await env.restart();
  await settle();
  ok(!env.disk.has('rec-1'), 'a lapsed hold still kept the file');
});

// ─── Trimming ─────────────────────────────────────────────────────────────────

await scenario('a trimmed recording uploads the processed file, and keeps the original until confirmed', async () => {
  const env = await environment();
  env.disk.set('rec-1__export', 4_000_000);
  env.failWith = { status: 503 };
  await env.worker.enqueueRecordingUpload({
    recordingId: 'rec-1',
    exportId: 'rec-1__export',
    project: 'p',
  });
  await env.advance(5 * MIN);
  ok(env.disk.has('rec-1'), 'the original was dropped before the trim was safe');
  ok(env.disk.has('rec-1__export'), 'the processed file was dropped');

  env.failWith = null;
  await env.advance(10 * MIN);
  ok(env.uploads[0].source === 'rec-1__export', `uploaded ${env.uploads[0].source}`);
  ok(!env.disk.has('rec-1') && !env.disk.has('rec-1__export'), 'both copies should be reclaimed');
});

await scenario('a processed file that went missing falls back to the original recording', async () => {
  const env = await environment();
  await env.worker.enqueueRecordingUpload({
    recordingId: 'rec-1',
    exportId: 'rec-1__export', // never written: the trim failed
    project: 'p',
  });
  await env.advance(5 * MIN);
  ok((await env.job()).stage === 'confirmed', 'the save did not finish');
  ok(env.uploads[0].source === 'rec-1', `uploaded ${env.uploads[0].source}`);
});

// ─── The queue's own upkeep ───────────────────────────────────────────────────

await scenario('the alarm is armed while work is owed and cleared when it is not', async () => {
  const env = await environment();
  env.failWith = { status: 503 };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(2 * MIN);
  ok(env.alarms.has('bestq-recording-upload'), 'nothing would wake the queue');

  env.failWith = null;
  await env.advance(20 * MIN);
  ok(!env.alarms.has('bestq-recording-upload'), 'the alarm kept firing with nothing to do');
});

await scenario('the queue reports what is still owed', async () => {
  const env = await environment();
  env.failWith = { status: 503 };
  await env.worker.enqueueRecordingUpload({ recordingId: 'rec-1', project: 'p' });
  await env.advance(2 * MIN);
  ok((await env.worker.outstandingUploadCount()) === 1);
  env.failWith = null;
  await env.advance(20 * MIN);
  ok((await env.worker.outstandingUploadCount()) === 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
