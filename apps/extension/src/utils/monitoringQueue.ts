/**
 * Durable queue for captured screenshots awaiting upload.
 *
 * ── Why a queue exists at all ────────────────────────────────────────────────
 * A capture that succeeded and an upload that failed are two different events.
 * The previous implementation logged the upload failure and moved on, so every
 * screenshot taken during a Wi-Fi drop, a VPN reconnect or a backend restart
 * was destroyed — a permanent hole in somebody's record caused by a temporary
 * network problem. Bytes that exist must not be thrown away because the network
 * is briefly unavailable.
 *
 * ── Why IndexedDB, and its own database ──────────────────────────────────────
 * `chrome.storage.local` is the wrong home for image blobs: it is quota-limited,
 * JSON-serialising, and read wholesale by other parts of the extension. So the
 * blobs go in IndexedDB.
 *
 * This is a SEPARATE database from `blobStorage.ts` (which holds recordings) on
 * purpose. Sharing one would mean a monitoring queue drain and a recording
 * finalisation contending for the same transactions, and a schema bump on
 * either side forcing an upgrade on the other. The two features must not be
 * able to break each other.
 *
 * ── Shared between contexts ──────────────────────────────────────────────────
 * IndexedDB is per-origin, so the offscreen document (which captures) and the
 * service worker (which can drain after the document is gone) see the same
 * records. That is what lets a queue survive the offscreen document being
 * reclaimed mid-session.
 */

const DB_NAME = 'bestq-monitoring-queue';
const DB_VERSION = 1;
const STORE = 'snapshots';

/** Bound the queue so an outage cannot fill the user's disk. */
const MAX_QUEUE_ENTRIES = 600;

/**
 * Give up on an entry after this many attempts.
 *
 * With the backoff below that is roughly half an hour of trying. Past that the
 * failure is not transient — a rejected payload, a revoked session — and
 * retrying forever would keep a dead entry at the head of the queue,
 * indefinitely blocking the ones behind it.
 */
export const MAX_UPLOAD_ATTEMPTS = 8;

export type QueuedSnapshotStatus = 'pending' | 'uploading' | 'failed';

export interface QueuedSnapshotRecord {
  /** Our idempotency key. Reused across every retry so the server dedupes. */
  clientSnapshotId: string;
  sessionId: string;
  project: string;
  /** When the frame was actually grabbed — never when it was uploaded (§42). */
  capturedAt: string;
  blob: Blob;
  mimeType: string;
  fileSize: number;
  attempts: number;
  status: QueuedSnapshotStatus;
  /** Epoch ms before which this entry must not be retried. */
  nextAttemptAt: number;
  lastError: string | null;
  /**
   * A storage grant already obtained for this entry.
   *
   * Kept so a retry after a successful PUT but a failed `complete` does not
   * request a second grant and upload the bytes again — the object is already
   * there and only the confirmation is outstanding.
   */
  storageKey: string | null;
  uploaded: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openQueueDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'clientSnapshotId' });
        // Drained oldest-capture-first, so a report reads in the order the day
        // actually happened even when entries were retried out of order.
        store.createIndex('capturedAt', 'capturedAt');
        store.createIndex('nextAttemptAt', 'nextAttemptAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open monitoring queue'));
  }).catch((err: unknown) => {
    // Let a later call try again rather than caching a rejected promise
    // forever — a transient open failure would otherwise disable the queue for
    // the rest of the session.
    dbPromise = null;
    throw err;
  });
  dbPromise = opening;
  return opening;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openQueueDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Monitoring queue error'));
      }),
  );
}

/**
 * Add a freshly captured frame.
 *
 * Enqueued *before* any upload is attempted, so a worker teardown or a crash
 * between capture and upload cannot lose the frame.
 */
export async function enqueueSnapshot(
  record: Omit<
    QueuedSnapshotRecord,
    'attempts' | 'status' | 'nextAttemptAt' | 'lastError' | 'storageKey' | 'uploaded'
  >,
): Promise<void> {
  await trimQueue();
  await tx('readwrite', (store) =>
    store.put({
      ...record,
      attempts: 0,
      status: 'pending' as QueuedSnapshotStatus,
      nextAttemptAt: 0,
      lastError: null,
      storageKey: null,
      uploaded: false,
    }),
  );
}

/** Everything still in the queue, oldest capture first. */
export async function listQueue(): Promise<QueuedSnapshotRecord[]> {
  const all = await tx<QueuedSnapshotRecord[]>('readonly', (store) => store.getAll());
  return all.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

/**
 * The next entries eligible for an attempt right now.
 *
 * Entries in `uploading` are skipped: another drain pass owns them, and two
 * passes uploading the same bytes is wasted bandwidth even though the server
 * would dedupe.
 */
export async function claimDueSnapshots(limit = 4): Promise<QueuedSnapshotRecord[]> {
  const now = Date.now();
  const all = await listQueue();
  return all
    .filter(
      (entry) =>
        entry.status !== 'uploading' &&
        entry.attempts < MAX_UPLOAD_ATTEMPTS &&
        entry.nextAttemptAt <= now,
    )
    .slice(0, limit);
}

export async function markUploading(clientSnapshotId: string): Promise<void> {
  const entry = await tx<QueuedSnapshotRecord | undefined>('readonly', (store) =>
    store.get(clientSnapshotId),
  );
  if (!entry) return;
  await tx('readwrite', (store) => store.put({ ...entry, status: 'uploading' }));
}

/** Record that the bytes are in storage but `complete` has not landed yet. */
export async function markBytesUploaded(
  clientSnapshotId: string,
  storageKey: string,
): Promise<void> {
  const entry = await tx<QueuedSnapshotRecord | undefined>('readonly', (store) =>
    store.get(clientSnapshotId),
  );
  if (!entry) return;
  await tx('readwrite', (store) => store.put({ ...entry, storageKey, uploaded: true }));
}

/**
 * Done — drop the entry and its blob.
 *
 * Deleting on success is what keeps the database from growing without bound
 * across a full working day of captures.
 */
export async function removeSnapshot(clientSnapshotId: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(clientSnapshotId));
}

/**
 * Attempt failed. Schedule the next one with exponential backoff.
 *
 * 1s, 2s, 4s … capped, so a brief blip retries almost immediately while a long
 * outage stops hammering a backend that is already struggling.
 */
export async function markAttemptFailed(
  clientSnapshotId: string,
  error: string,
): Promise<QueuedSnapshotRecord | null> {
  const entry = await tx<QueuedSnapshotRecord | undefined>('readonly', (store) =>
    store.get(clientSnapshotId),
  );
  if (!entry) return null;

  const attempts = entry.attempts + 1;
  const backoffMs = Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
  const updated: QueuedSnapshotRecord = {
    ...entry,
    attempts,
    status: attempts >= MAX_UPLOAD_ATTEMPTS ? 'failed' : 'pending',
    nextAttemptAt: Date.now() + backoffMs,
    lastError: error.slice(0, 300),
  };
  await tx('readwrite', (store) => store.put(updated));
  return updated;
}

/**
 * Queue health, for the UI.
 *
 * `pending` is what the popup surfaces as "N screenshots waiting to upload";
 * `failed` is the count that will never be sent and is worth telling the user
 * about separately, because it means data loss rather than a delay.
 */
export async function queueStats(): Promise<{
  total: number;
  pending: number;
  failed: number;
  oldestCapturedAt: string | null;
  bytes: number;
  lastError: string | null;
}> {
  const all = await listQueue();
  // The most recent failure reason, carried out of the queue so the popup can
  // show *why* uploads are stuck. A count on its own ("4 could not be
  // uploaded") is not diagnosable by anyone, including the person who has to
  // fix it — the reason lived only in an IndexedDB row nobody opens.
  const lastError =
    all
      .filter((entry) => entry.lastError)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .at(-1)?.lastError ?? null;
  return {
    total: all.length,
    pending: all.filter((entry) => entry.status !== 'failed').length,
    failed: all.filter((entry) => entry.status === 'failed').length,
    oldestCapturedAt: all[0]?.capturedAt ?? null,
    bytes: all.reduce((sum, entry) => sum + (entry.fileSize || 0), 0),
    lastError,
  };
}

/**
 * Enforce the size bound by dropping the oldest *failed* entries first, then
 * the oldest pending ones.
 *
 * Dropping the oldest is the right choice over refusing to enqueue: the newest
 * frame describes what the user is doing now, and a queue that refuses new
 * captures during an outage would turn a network problem into a monitoring
 * blackout that persists after the network returns.
 */
async function trimQueue(): Promise<void> {
  const all = await listQueue();
  if (all.length < MAX_QUEUE_ENTRIES) return;

  const overBy = all.length - MAX_QUEUE_ENTRIES + 1;
  const doomed = [
    ...all.filter((entry) => entry.status === 'failed'),
    ...all.filter((entry) => entry.status !== 'failed'),
  ].slice(0, overBy);

  await Promise.all(doomed.map((entry) => removeSnapshot(entry.clientSnapshotId)));
  console.warn(`[Monitoring] Queue full — dropped ${doomed.length} oldest snapshot(s)`);
}

/** Remove every entry for a session. Used after a session is fully settled. */
export async function purgeSessionQueue(sessionId: string): Promise<number> {
  const all = await listQueue();
  const mine = all.filter((entry) => entry.sessionId === sessionId);
  await Promise.all(mine.map((entry) => removeSnapshot(entry.clientSnapshotId)));
  return mine.length;
}

/** Entries whose session is not the current one — abandoned by a crash. */
export async function purgeStaleSessions(currentSessionId: string | null): Promise<number> {
  const all = await listQueue();
  const stale = all.filter((entry) => entry.sessionId !== currentSessionId);
  await Promise.all(stale.map((entry) => removeSnapshot(entry.clientSnapshotId)));
  return stale.length;
}
