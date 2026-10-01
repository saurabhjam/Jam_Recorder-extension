/**
 * The upload queue for finished recordings — durable, and the only thing that
 * may decide a local video can go.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Saving used to happen entirely inside the editor tab: it read the file, sent
 * it, and on failure showed "Upload failed". Close that tab, lose the network,
 * let the sign-in lapse, or let the service worker be torn down mid-upload, and
 * nothing anywhere would ever try again. The recording was still on disk — but
 * only a person who knew to go back into Drafts and press Save would ever
 * discover that, and most did not.
 *
 * Now the editor hands the job here first and the upload becomes the
 * extension's problem rather than the tab's: a record in storage that survives
 * restarts, retried on an alarm with exponential backoff, resumed phase by
 * phase so bytes already accepted are never sent twice, and finished only when
 * the server confirms it holds both the file and the record. The local file is
 * deleted at exactly one moment — that confirmation — and at no other.
 *
 * The bytes themselves are pushed by the offscreen document, which is a DOM
 * context with OPFS, IndexedDB and upload progress. This worker decides what
 * should happen and remembers what did.
 */

import {
  UPLOAD_POLICY,
  canDeleteLocal,
  classifyUploadFailure,
  dueJobs,
  isWornOut,
  uploadRetryDelayMs,
  type FailureKind,
  type UploadJob,
  type UploadStage,
} from '@/utils/recordingUploadPolicy';

/** Where the queue lives. Metadata only — the video stays in OPFS/IndexedDB. */
const JOBS_KEY = 'st_upload_jobs';

/**
 * Windows that are still using a local copy, by recording id.
 *
 * An editor showing a recording is playing it straight off the disk copy, so
 * reclaiming that copy the instant the upload is confirmed pulls the file out
 * from under the player: the video stops, and neither play nor the scrubber
 * does anything afterwards. A hold defers the reclaim until the window that
 * holds it has gone. The value is when the hold lapses on its own, so a window
 * that crashes cannot keep a file forever.
 */
const HOLDS_KEY = 'st_upload_holds';

/** How long a hold lasts without being renewed. */
const HOLD_TTL_MS = 6 * 3_600_000;

export const RECORDING_UPLOAD_ALARM = 'bestq-recording-upload';

/** What the worker needs from its surroundings, so tests can supply their own. */
export interface UploaderBridge {
  /** Run one attempt in a DOM context. Rejects with an UploadAttemptError. */
  attempt: (job: UploadJob) => Promise<AttemptResult>;
  /** Delete the recording's local files. Called only after confirmation. */
  discardLocal: (recordingId: string, exportId: string | null) => Promise<void>;
  /** Tell the rest of the extension a job moved. */
  onChange?: (jobs: UploadJob[]) => void;
}

export interface AttemptResult {
  /** The stored file name, once the bytes are in. */
  videoFileName: string;
  /** The created record, once it exists. */
  backendRecordId: string;
  shareUrl?: string | null;
  videoUrl?: string | null;
}

/** A failure carrying what the server said, so it can be classified. */
export class UploadAttemptError extends Error {
  readonly status: number;

  /** Phase results that DID land, so the retry can skip them. */
  readonly partial: Partial<AttemptResult>;

  constructor(message: string, status: number, partial: Partial<AttemptResult> = {}) {
    super(message);
    this.name = 'UploadAttemptError';
    this.status = status;
    this.partial = partial;
  }
}

let bridge: UploaderBridge | null = null;

export function configureUploader(next: UploaderBridge): void {
  bridge = next;
}

// ─── The queue ────────────────────────────────────────────────────────────────

export async function listUploadJobs(): Promise<UploadJob[]> {
  try {
    const stored = await chrome.storage.local.get([JOBS_KEY]);
    return (stored[JOBS_KEY] as UploadJob[] | undefined) ?? [];
  } catch {
    return [];
  }
}

async function writeJobs(jobs: UploadJob[]): Promise<void> {
  await chrome.storage.local.set({ [JOBS_KEY]: jobs });
  try {
    bridge?.onChange?.(jobs);
    void chrome.runtime
      .sendMessage({ type: 'RECORDING_UPLOADS_CHANGED', payload: { jobs } })
      ?.catch?.(() => {});
  } catch {
    /* no listener */
  }
}

async function patchJob(recordingId: string, updates: Partial<UploadJob>): Promise<void> {
  const jobs = await listUploadJobs();
  const next = jobs.map((job) => (job.recordingId === recordingId ? { ...job, ...updates } : job));
  await writeJobs(next);
}

/**
 * Take responsibility for uploading a recording.
 *
 * Called before the first byte is sent, deliberately: a job that exists only
 * after a successful upload is a job that cannot survive the upload failing.
 * Called again for a recording already queued, it keeps the existing job's
 * identity and progress rather than starting a second one.
 */
export async function enqueueRecordingUpload(input: {
  recordingId: string;
  exportId?: string | null;
  stage?: UploadStage;
  project?: string;
  recordBody?: Record<string, unknown>;
  title?: string;
  sizeBytes?: number;
  /** Already-stored bytes, so a retry starts at the record instead. */
  videoFileName?: string | null;
  /** An already-created record, so a retry never creates a second one. */
  backendRecordId?: string | null;
}): Promise<UploadJob> {
  const jobs = await listUploadJobs();
  const existing = jobs.find((job) => job.recordingId === input.recordingId);
  if (existing) {
    const updated: UploadJob = {
      ...existing,
      exportId: input.exportId ?? existing.exportId ?? null,
      project: input.project ?? existing.project,
      // A fresh save carries fresh choices — a new title, a new project — and
      // those replace what an earlier attempt queued.
      recordBody: input.recordBody ?? existing.recordBody,
      title: input.title ?? existing.title,
      sizeBytes: input.sizeBytes ?? existing.sizeBytes,
      videoFileName: input.videoFileName ?? existing.videoFileName ?? null,
      backendRecordId: input.backendRecordId ?? existing.backendRecordId ?? null,
      // A job the person has asked for again is due now, whatever its backoff.
      stage: existing.stage === 'confirmed' ? existing.stage : (input.stage ?? 'pending'),
      nextAttemptAt: existing.stage === 'confirmed' ? existing.nextAttemptAt : Date.now(),
    };
    await writeJobs(jobs.map((job) => (job.recordingId === input.recordingId ? updated : job)));
    await ensureAlarm();
    return updated;
  }

  const job: UploadJob = {
    recordingId: input.recordingId,
    uploadId: `up-${input.recordingId}-${Date.now().toString(36)}`,
    stage: input.stage ?? 'pending',
    attempts: 0,
    createdAt: Date.now(),
    nextAttemptAt: Date.now(),
    exportId: input.exportId ?? null,
    project: input.project,
    recordBody: input.recordBody,
    title: input.title,
    sizeBytes: input.sizeBytes,
    videoFileName: input.videoFileName ?? null,
    backendRecordId: input.backendRecordId ?? null,
    lastError: null,
    lastErrorKind: null,
  };
  await writeJobs([...jobs, job]);
  await ensureAlarm();
  return job;
}

/**
 * The server has the file and the record: the one path that deletes a video.
 *
 * Called by the editor when its own save succeeds, and by this worker when a
 * retry does. Either way the deletion happens here, after the confirmation is
 * written down, so a crash between the two leaves a job that is confirmed and a
 * file that is merely still on disk — which costs space, not a recording.
 */
export async function confirmRecordingUpload(
  recordingId: string,
  result: { backendRecordId: string; videoFileName?: string | null },
): Promise<void> {
  const jobs = await listUploadJobs();
  const job = jobs.find((entry) => entry.recordingId === recordingId);
  const confirmed: UploadJob = {
    ...(job ?? {
      recordingId,
      uploadId: `up-${recordingId}`,
      attempts: 0,
      createdAt: Date.now(),
      exportId: null,
    }),
    stage: 'confirmed',
    nextAttemptAt: Date.now(),
    backendRecordId: result.backendRecordId,
    videoFileName: result.videoFileName ?? job?.videoFileName ?? null,
    lastError: null,
    lastErrorKind: null,
  } as UploadJob;

  await writeJobs(
    job
      ? jobs.map((entry) => (entry.recordingId === recordingId ? confirmed : entry))
      : [...jobs, confirmed],
  );

  if (canDeleteLocal(confirmed)) {
    const holds = await readHolds();
    if (holds[recordingId]) {
      // A window still has it open. Marked for reclaim and left alone until
      // that window is done — playing a recording must not stop working the
      // moment it finishes uploading.
      await patchJob(recordingId, { pendingDiscard: true });
    } else {
      try {
        await bridge?.discardLocal(recordingId, confirmed.exportId ?? null);
      } catch (err) {
        // The video is uploaded; failing to reclaim the disk copy is untidy,
        // not a loss, and the next sweep tries again.
        console.warn('[Uploads] could not remove the local copy after upload:', err);
        await patchJob(recordingId, { pendingDiscard: true });
      }
    }
  }
  await ensureAlarm();
}

type Holds = Record<string, number>;

async function readHolds(): Promise<Holds> {
  try {
    const stored = await chrome.storage.local.get([HOLDS_KEY]);
    const holds = (stored[HOLDS_KEY] as Holds | undefined) ?? {};
    const now = Date.now();
    // Lapsed ones are simply not holds any more.
    return Object.fromEntries(Object.entries(holds).filter(([, until]) => until > now));
  } catch {
    return {};
  }
}

/** This window is using the local copy of `recordingId`; do not reclaim it yet. */
export async function holdLocalCopy(recordingId: string): Promise<void> {
  const holds = await readHolds();
  holds[recordingId] = Date.now() + HOLD_TTL_MS;
  await chrome.storage.local.set({ [HOLDS_KEY]: holds });
}

/** This window is finished with it. Anything deferred for it is reclaimed now. */
export async function releaseLocalCopy(recordingId: string): Promise<void> {
  const holds = await readHolds();
  delete holds[recordingId];
  await chrome.storage.local.set({ [HOLDS_KEY]: holds });
  await sweepDeferredDiscards();
}

/**
 * Reclaim the local copies of recordings that are uploaded, confirmed and no
 * longer being used by any window.
 */
export async function sweepDeferredDiscards(): Promise<void> {
  const [jobs, holds] = await Promise.all([listUploadJobs(), readHolds()]);
  const ready = jobs.filter(
    (job) => job.pendingDiscard && canDeleteLocal(job) && !holds[job.recordingId],
  );
  if (ready.length === 0) return;
  for (const job of ready) {
    try {
      await bridge?.discardLocal(job.recordingId, job.exportId ?? null);
      await patchJob(job.recordingId, { pendingDiscard: false });
    } catch (err) {
      console.warn('[Uploads] could not reclaim a local copy yet:', err);
    }
  }
}

/** The person discarded the recording, or paused its upload. */
export async function pauseRecordingUpload(recordingId: string): Promise<void> {
  await patchJob(recordingId, { stage: 'paused' });
}

export async function resumeRecordingUpload(recordingId: string): Promise<void> {
  await patchJob(recordingId, { stage: 'pending', nextAttemptAt: Date.now(), attempts: 0 });
  await ensureAlarm();
  void drainRecordingUploads('resume');
}

/** Forget a job entirely — used when the person deletes the recording. */
export async function forgetRecordingUpload(recordingId: string): Promise<void> {
  const jobs = await listUploadJobs();
  await writeJobs(jobs.filter((job) => job.recordingId !== recordingId));
}

// ─── Running them ─────────────────────────────────────────────────────────────

let running: Promise<void> | null = null;

export function drainRecordingUploads(reason: string): Promise<void> {
  if (running) return running;
  running = runDrain(reason).finally(() => {
    running = null;
  });
  return running;
}

async function runDrain(reason: string): Promise<void> {
  if (!bridge) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const jobs = await listUploadJobs();
  const due = dueJobs(jobs, Date.now());
  if (due.length === 0) {
    await ensureAlarm();
    return;
  }
  console.log(`[Uploads] ${due.length} recording(s) to upload (${reason})`);

  for (const job of due) {
    // One at a time: these are whole videos, and three at once would starve
    // both the network and the machine.
    await attemptJob(job);
  }
  await ensureAlarm();
}

async function attemptJob(job: UploadJob): Promise<void> {
  if (isWornOut(job, Date.now())) {
    console.warn(`[Uploads] ${job.recordingId} has been retried for two weeks — pausing it`);
    await patchJob(job.recordingId, {
      stage: 'paused',
      lastError: 'Could not be uploaded after many attempts. The video is still saved here.',
    });
    return;
  }

  await patchJob(job.recordingId, { stage: 'uploading' });
  try {
    const result = await bridge!.attempt(job);
    await confirmRecordingUpload(job.recordingId, {
      backendRecordId: result.backendRecordId,
      videoFileName: result.videoFileName,
    });
    console.log(`[Uploads] ${job.recordingId} uploaded and confirmed`);
  } catch (err) {
    await settleFailure(job, err);
  }
}

async function settleFailure(job: UploadJob, err: unknown): Promise<void> {
  const status = err instanceof UploadAttemptError ? err.status : 0;
  const partial = err instanceof UploadAttemptError ? err.partial : {};
  const kind: FailureKind = classifyUploadFailure({ status });
  const attempts = job.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);

  const updates: Partial<UploadJob> = {
    // Whatever landed is kept, so the retry resumes instead of restarting: the
    // bytes are the expensive part and the server already has them.
    videoFileName: partial.videoFileName ?? job.videoFileName ?? null,
    backendRecordId: partial.backendRecordId ?? job.backendRecordId ?? null,
    attempts,
    lastError: message.slice(0, 300),
    lastErrorKind: kind,
  };

  if (kind === 'fatal') {
    // The server will not take this. Stop trying by itself — and keep the file,
    // which stays in Drafts for the person to download or retry by hand.
    console.warn(`[Uploads] ${job.recordingId} was refused by the server: ${message}`);
    await patchJob(job.recordingId, { ...updates, stage: 'paused' });
    return;
  }

  const delay = uploadRetryDelayMs(attempts);
  console.warn(
    `[Uploads] ${job.recordingId} did not go up (${kind}: ${message}) — retrying in ${Math.round(delay / 1000)}s`,
  );
  await patchJob(job.recordingId, {
    ...updates,
    stage: 'pending',
    nextAttemptAt: Date.now() + delay,
  });
}

// ─── Waking up ────────────────────────────────────────────────────────────────

/**
 * Keep the alarm armed exactly while there is something to upload.
 *
 * An alarm rather than a timer: a service worker is torn down between events,
 * and a setTimeout dies with it. This is what makes "it retries even if you
 * close the browser" true.
 */
async function ensureAlarm(): Promise<void> {
  const jobs = await listUploadJobs();
  const outstanding = jobs.some((job) => job.stage !== 'confirmed' && job.stage !== 'paused');
  try {
    if (outstanding) {
      const existing = await chrome.alarms.get(RECORDING_UPLOAD_ALARM);
      if (!existing) chrome.alarms.create(RECORDING_UPLOAD_ALARM, { periodInMinutes: 1 });
    } else {
      await chrome.alarms.clear(RECORDING_UPLOAD_ALARM);
    }
  } catch {
    /* the next startup re-arms it */
  }
}

export async function handleRecordingUploadAlarm(): Promise<void> {
  await drainRecordingUploads('alarm');
  await sweepDeferredDiscards();
}

/**
 * Pick up where a torn-down worker left off.
 *
 * A job left mid-attempt says 'uploading' and nothing is uploading it any more,
 * so it goes back to pending — and because the phases it finished were written
 * down as they happened, the retry carries on from there rather than sending
 * the whole video again.
 */
export async function restoreRecordingUploads(): Promise<void> {
  const jobs = await listUploadJobs();
  if (jobs.length === 0) return;
  const now = Date.now();
  const revived = jobs.map((job) =>
    job.stage === 'uploading' || job.stage === 'processing'
      ? { ...job, stage: 'pending' as UploadStage, nextAttemptAt: now }
      : job,
  );
  const stale = revived.filter((job) => job.stage !== 'confirmed');
  if (stale.length > 0) {
    console.log(`[Uploads] ${stale.length} recording(s) still to upload after a restart`);
  }
  // Confirmed jobs are kept briefly so the UI can show "Uploaded", then dropped.
  const kept = revived.filter(
    (job) => job.stage !== 'confirmed' || now - job.createdAt < UPLOAD_POLICY.MAX_JOB_AGE_MS,
  );
  await writeJobs(kept);
  await ensureAlarm();
  // A window that was open when the browser closed released nothing, so its
  // holds lapse on their own and whatever they deferred is reclaimed here.
  await sweepDeferredDiscards();
  void drainRecordingUploads('restart');
}

/** The machine is back online: try everything that was waiting for exactly that. */
export async function notifyUploadsOnline(): Promise<void> {
  const jobs = await listUploadJobs();
  const waiting = jobs.filter((job) => job.stage === 'pending');
  if (waiting.length === 0) return;
  await writeJobs(
    jobs.map((job) => (job.stage === 'pending' ? { ...job, nextAttemptAt: Date.now() } : job)),
  );
  void drainRecordingUploads('online');
}

/** For the popup: is anything still owed to the server? */
export async function outstandingUploadCount(): Promise<number> {
  const jobs = await listUploadJobs();
  return jobs.filter((job) => job.stage !== 'confirmed' && job.stage !== 'paused').length;
}
