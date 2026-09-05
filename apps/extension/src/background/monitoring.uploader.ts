/**
 * Snapshot upload drain, owned by the service worker.
 *
 * ── Why this does not live in the offscreen document ──────────────────────────
 * It used to. The offscreen document captures the frames, so draining them from
 * there looked natural — and it worked until the extension was reloaded.
 *
 * An offscreen document holding a live `getDisplayMedia` stream survives a
 * reload of the extension that created it. What does not survive is its binding
 * to that extension: `chrome.storage` and the rest of the namespaces are torn
 * down, while the page, its timers, its IndexedDB handle and the capture stream
 * all keep running. The result was a document that went on grabbing frames and
 * queueing them perfectly, and failed every single upload on
 * `chrome.storage.local` with `Cannot read properties of undefined (reading
 * 'local')` — before any network request was made, which is why no upload call
 * ever appeared in the network log.
 *
 * The service worker has no such split state: it is restarted with the
 * extension, and it already owns the token, the project and the session. The
 * queue is IndexedDB on the extension's own origin, so both contexts see the
 * same rows — the offscreen document writes them, this drains them.
 *
 * The service worker can be torn down mid-upload. That is safe: an entry is
 * only removed after the server confirms it, `clientSnapshotId` makes a retry
 * idempotent, and a successful PUT is recorded so a retry resumes at the
 * confirmation step instead of re-sending the bytes.
 */

import {
  requestSnapshotUpload,
  uploadSnapshotBytes,
  uploadSnapshotBytesViaApi,
  completeSnapshot,
  MonitoringApiError,
} from '@/services/monitoring.api';
import {
  claimDueSnapshots,
  markUploading,
  markBytesUploaded,
  markAttemptFailed,
  removeSnapshot,
  queueStats,
} from '@/utils/monitoringQueue';

/** How many entries one pass uploads. Small: the worker must stay responsive. */
const BATCH_SIZE = 3;

/**
 * Periodic sweep.
 *
 * The drain is normally triggered by the offscreen document the moment a frame
 * is queued, so this only has to catch what that missed — a capture that landed
 * while the worker was asleep, or a retry whose backoff has since expired.
 */
const SWEEP_INTERVAL_MS = 15_000;

let draining = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

interface UploaderHooks {
  /** Queue depth changed; the popup shows this. */
  onStats: (stats: Awaited<ReturnType<typeof queueStats>>) => void | Promise<void>;
  /** One snapshot is confirmed stored. */
  onStored: (capturedAt: string) => void | Promise<void>;
  /** The session is gone server-side, so nothing queued for it can ever land. */
  onSessionInactive: () => void | Promise<void>;
}

let hooks: UploaderHooks | null = null;

export function configureUploader(next: UploaderHooks): void {
  hooks = next;
}

/**
 * Upload what is due, oldest first.
 *
 * Safe to call concurrently — overlapping calls collapse into the one already
 * running rather than uploading the same entry twice.
 */
export async function drainSnapshotQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const due = await claimDueSnapshots(BATCH_SIZE);
    for (const entry of due) {
      await markUploading(entry.clientSnapshotId);
      try {
        let storageKey = entry.storageKey;

        if (!entry.uploaded || !storageKey) {
          const grant = await requestSnapshotUpload(entry.project, entry.sessionId, {
            clientSnapshotId: entry.clientSnapshotId,
            capturedAt: entry.capturedAt,
            mimeType: entry.mimeType,
            fileSize: entry.fileSize,
          });

          // PROXY means object storage has no browser-reachable HTTPS address,
          // so the bytes go through the API. An older server sends no strategy
          // at all, and that only ever meant DIRECT.
          if (grant.uploadStrategy === 'PROXY' || !grant.uploadUrl) {
            await uploadSnapshotBytesViaApi(
              entry.project,
              entry.sessionId,
              entry.clientSnapshotId,
              entry.blob,
              entry.mimeType,
            );
          } else {
            try {
              await uploadSnapshotBytes(grant.uploadUrl, entry.blob, entry.mimeType);
            } catch (directFailure) {
              // Status 0 means the request never reached storage at all: an
              // unreachable host, mixed content, a blocked private-network
              // request. That is a property of the deployment, not of this
              // frame, so retrying the same URL forever is pointless — the API
              // can take the bytes instead. A deployment whose storage really
              // is public never gets here, and one whose API is too old to
              // accept them fails on the next line rather than silently.
              if (!(directFailure instanceof MonitoringApiError) || directFailure.status !== 0) {
                throw directFailure;
              }
              console.warn(
                '[Monitoring] storage was unreachable from the browser; uploading through the API',
              );
              await uploadSnapshotBytesViaApi(
                entry.project,
                entry.sessionId,
                entry.clientSnapshotId,
                entry.blob,
                entry.mimeType,
              );
            }
          }

          storageKey = grant.storageKey;
          await markBytesUploaded(entry.clientSnapshotId, storageKey);
        }

        await completeSnapshot(entry.project, entry.sessionId, {
          clientSnapshotId: entry.clientSnapshotId,
          storageKey,
          capturedAt: entry.capturedAt,
        });

        await removeSnapshot(entry.clientSnapshotId);
        await hooks?.onStored(entry.capturedAt);
      } catch (err) {
        // Already stored server-side — a previous attempt got further than it
        // managed to report. Nothing to retry.
        if (err instanceof MonitoringApiError && err.code === 'MONITORING_DUPLICATE_SNAPSHOT') {
          await removeSnapshot(entry.clientSnapshotId);
          continue;
        }
        // The session is gone; these frames belong to nothing and every retry
        // would fail identically.
        if (err instanceof MonitoringApiError && err.code === 'MONITORING_SESSION_NOT_ACTIVE') {
          await hooks?.onSessionInactive();
          return;
        }
        await markAttemptFailed(
          entry.clientSnapshotId,
          err instanceof Error ? err.message : 'Upload failed',
        );
      }
    }
    await publishStats();
  } catch (err) {
    console.warn('[Monitoring] snapshot drain failed:', err);
  } finally {
    draining = false;
  }
}

export async function publishStats(): Promise<void> {
  try {
    await hooks?.onStats(await queueStats());
  } catch {
    /* the queue is unreadable; the next sweep tries again */
  }
}

export function startUploader(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => void drainSnapshotQueue(), SWEEP_INTERVAL_MS);
  void drainSnapshotQueue();
}

export function stopUploader(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * Drain until the queue stops shrinking, for session stop.
 *
 * Bounded by both a deadline and a no-progress check: a queue that cannot
 * upload must not hold the stop open, and the entries survive in IndexedDB to
 * be retried by the next session either way.
 */
export async function flushSnapshotQueue(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = Number.POSITIVE_INFINITY;

  while (Date.now() < deadline) {
    const { total } = await queueStats();
    if (total === 0 || total >= previous) return;
    previous = total;
    await drainSnapshotQueue();
  }
}
