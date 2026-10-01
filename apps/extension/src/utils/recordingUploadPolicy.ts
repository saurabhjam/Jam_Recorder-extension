/**
 * Recording uploads — the decisions, with no I/O.
 *
 * ── The promise this file exists to keep ─────────────────────────────────────
 * A finished recording is never lost. The file on disk is the source of truth
 * until the server confirms it has the video, and nothing — a trim that fails,
 * a server that is down, a sign-in that lapsed, a closed window, a crash, a
 * restart — may delete it before then. Every failure delays the upload; none of
 * them ends it.
 *
 * Keeping these rules here, as pure functions, is what makes "the recording
 * survives X" a test rather than a thing someone finds out afterwards.
 */

export const UPLOAD_POLICY = {
  /**
   * Retry spacing while an upload cannot go through. Exponential, capped at ten
   * minutes: long enough not to hammer a server that is down, short enough that
   * a recording is on its way within minutes of it coming back.
   */
  RETRY_BACKOFF_MS: [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
  RETRY_JITTER_RATIO: 0.2,

  /**
   * A job is retried for this long before it is left for the person to deal
   * with. Fourteen days, and even then the video stays on disk and in Drafts:
   * giving up means "stop trying by itself", never "delete it".
   */
  MAX_JOB_AGE_MS: 14 * 24 * 3_600_000,

  /** How long a single attempt may run before it is treated as stalled. */
  ATTEMPT_TIMEOUT_MS: 30 * 60_000,

  /**
   * Trimming is real-time re-recording, so its budget follows the clip: twice
   * its length plus a minute. Past that the trim is abandoned and the original
   * recording is uploaded instead — a save that cannot finish is worse than a
   * save that ships the untrimmed file and says so.
   */
  TRIM_BUDGET_MS: (durationSeconds: number): number =>
    Math.max(60_000, Math.round(durationSeconds * 2_000) + 60_000),
} as const;

/**
 * Where a recording is in its life.
 *
 *   saved       on disk, nothing asked of it yet
 *   processing  being trimmed or re-mixed
 *   pending     waiting for its turn, or for the server to come back
 *   uploading   bytes are going up now
 *   uploaded    the server has the file; the record may still need creating
 *   confirmed   the server has both, and said so — only now may the file go
 *   paused      the person stopped it, or it has been retried for two weeks
 */
export type UploadStage =
  | 'saved'
  | 'processing'
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'confirmed'
  | 'paused';

export interface UploadJob {
  /** The recording this is for; also the key of its file on disk. */
  recordingId: string;
  /**
   * Stable across every retry, and sent with the record.
   *
   * Two attempts that both reach the server must not leave two copies of the
   * same recording in the library, and an attempt whose answer was lost on the
   * way back is exactly when that happens.
   */
  uploadId: string;
  stage: UploadStage;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  /** Set once the bytes are stored, so a retry never sends them twice. */
  videoFileName?: string | null;
  /** Set once the record exists, so a retry never creates a second one. */
  backendRecordId?: string | null;
  /** A processed (trimmed/re-mixed) file was written; upload this instead. */
  exportId?: string | null;
  /** The project the record belongs to. */
  project?: string;
  /**
   * The create-record body, as the editor built it.
   *
   * Carried with the job rather than rebuilt later: a retry may happen days
   * after the editor tab closed, on a machine that has since restarted, and
   * nothing else still knows what the person typed. `url` and `size` are filled
   * in at upload time, since they depend on the file that was stored.
   */
  recordBody?: Record<string, unknown>;
  /** What the UI shows while this is in the queue. */
  title?: string;
  sizeBytes?: number;
  lastError?: string | null;
  lastErrorKind?: FailureKind | null;
  /**
   * Uploaded and confirmed, but the local copy is still in use by a window.
   * It is reclaimed once nothing holds it — never before.
   */
  pendingDiscard?: boolean;
}

/**
 * What a failed attempt means.
 *
 *   retry  the server, the network or this machine was not ready — try again
 *   auth   the sign-in lapsed — try again once it is back, never give up
 *   fatal  the server refused this content and always will
 */
export type FailureKind = 'retry' | 'auth' | 'fatal';

export function classifyUploadFailure(failure: { status: number; message?: string }): FailureKind {
  const { status } = failure;
  // Never reached the server, or the server is unwell. Always later.
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) {
    return 'retry';
  }
  if (status === 401 || status === 403) return 'auth';

  // 413 is "too big for this server right now" — an operator can raise the
  // limit, and the recording must still be here when they do.
  if (status === 413) return 'retry';

  // A real 4xx verdict on the payload. Even here the file is kept and offered
  // in Drafts; 'fatal' only stops the automatic retries.
  if (status >= 400) return 'fatal';
  return 'retry';
}

/** Delay before the next attempt. */
export function uploadRetryDelayMs(attempts: number, random: () => number = Math.random): number {
  const ladder = UPLOAD_POLICY.RETRY_BACKOFF_MS;
  const base = ladder[Math.min(Math.max(attempts, 1), ladder.length) - 1];
  const spread = base * UPLOAD_POLICY.RETRY_JITTER_RATIO;
  return Math.round(base - spread + random() * spread * 2);
}

/** The jobs that should be attempted now, oldest first. */
export function dueJobs(jobs: UploadJob[], nowMs: number): UploadJob[] {
  return jobs
    .filter((job) => job.stage !== 'confirmed' && job.stage !== 'paused')
    .filter((job) => job.nextAttemptAt <= nowMs)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Has this job been retried for as long as it is going to be? */
export function isWornOut(job: UploadJob, nowMs: number): boolean {
  return nowMs - job.createdAt >= UPLOAD_POLICY.MAX_JOB_AGE_MS;
}

/**
 * May the local copy be deleted?
 *
 * One rule, in one place: only once the server has confirmed it holds both the
 * file and the record. Everything else in the extension asks this rather than
 * deciding for itself.
 */
export function canDeleteLocal(job: Pick<UploadJob, 'stage' | 'backendRecordId'>): boolean {
  return job.stage === 'confirmed' && Boolean(job.backendRecordId);
}

/**
 * Does saving this recording need the slow path at all?
 *
 * Re-encoding is real-time: a twenty-minute recording takes twenty minutes and
 * sits behind a "Trimming" bar the whole way. It is worth that only when the
 * output would genuinely differ from the file already on disk — an actual trim,
 * or an actual change of which audio it carries.
 */
export function needsReencode(choice: {
  /** 0–1 of the clip. */
  trimStart: number;
  trimEnd: number;
  muteMic: boolean;
  muteSystem: boolean;
  /** The recorded file already carries every audio source. */
  audioMixed: boolean;
  /** A separately recorded mic track exists for this recording. */
  hasMicTrack: boolean;
  durationSeconds: number;
}): boolean {
  if (choice.durationSeconds <= 0) return false;
  if (!isFullClip(choice.trimStart, choice.trimEnd)) return true;

  if (choice.audioMixed) {
    // Its own track is system + mic, so a mute means swapping in a side track.
    return choice.muteMic || choice.muteSystem;
  }
  // Older recordings: the main track is system-only, so an audible mic has to
  // be folded in, and muting the system means using the mic track alone.
  if (choice.muteSystem) return true;
  return !choice.muteMic && choice.hasMicTrack;
}

/** Is the selection the whole clip, within the slack of a dragged handle? */
export function isFullClip(trimStart: number, trimEnd: number): boolean {
  return trimStart <= 0.005 && trimEnd >= 0.995;
}

/** What the person should be told, given where the job is. */
export function describeStage(job: UploadJob, online = true): string {
  switch (job.stage) {
    case 'saved':
      return 'Saved on this computer';
    case 'processing':
      return 'Preparing the video';
    case 'pending':
      return online
        ? 'Waiting to upload — this will retry by itself'
        : 'Waiting for a connection — this will upload by itself';
    case 'uploading':
      return 'Uploading';
    case 'uploaded':
      return 'Uploaded — finishing up';
    case 'confirmed':
      return 'Uploaded';
    case 'paused':
      return 'Paused — the video is still saved on this computer';
    default:
      return 'Saved on this computer';
  }
}
