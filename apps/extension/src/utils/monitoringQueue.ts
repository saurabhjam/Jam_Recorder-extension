/**
 * Durable outbox for everything monitoring sends to the server.
 *
 * ── Why everything goes through here ─────────────────────────────────────────
 * A capture that succeeded and an upload that failed are two different events,
 * and so are an idle period that happened and a request that could not report
 * it. The previous design only queued screenshots — and even those were given up
 * on after eight attempts, roughly half an hour — while activity sat in a
 * `chrome.storage` array that session stop wiped whether or not it had been
 * sent, and inactivity, pause, resume and stop were plain requests that were
 * simply lost if the server was down at that moment. A four-hour outage
 * therefore erased four hours of somebody's record.
 *
 * Now every write is recorded here first and removed only when the server has
 * confirmed it or has said, in its own words, that it can never accept it.
 *
 * ── Why IndexedDB, and its own database ──────────────────────────────────────
 * `chrome.storage.local` is quota-limited, JSON-serialising, and has no
 * transactions — two writers doing read-modify-write on the same array silently
 * lose each other's rows. IndexedDB has transactions, holds blobs natively, and
 * with the `unlimitedStorage` permission is exempt from eviction under disk
 * pressure, which is what "survives the worst case" requires.
 *
 * This is a SEPARATE database from `blobStorage.ts` (which holds recordings) on
 * purpose: a monitoring drain and a recording finalisation must not contend for
 * the same transactions, and a schema bump on one must not force the other.
 *
 * ── Stores ───────────────────────────────────────────────────────────────────
 *   snapshots   one screenshot each, blob included, keyed by clientSnapshotId
 *   activities  one activity row each; batched at send time
 *   events      inactivity start/end, pause, resume, stop — ORDERED per session
 *   sessions    what the client has learned about a session's server state
 *
 * No function here makes a network request. Sending is `monitoring.sync.ts`;
 * the rules it follows are `monitoringSyncPolicy.ts`.
 */

import type { MonitoringActivityPayload, MonitoringPauseInterval } from '@/types/monitoring';
import { SYNC_POLICY, pickThinningVictims, type SyncLane } from './monitoringSyncPolicy';

const DB_NAME = 'bestq-monitoring-queue';
/** 1 held screenshots only. 2 added activities, events and sessions. */
const DB_VERSION = 2;

const SNAPSHOTS = 'snapshots';
const ACTIVITIES = 'activities';
const EVENTS = 'events';
const SESSIONS = 'sessions';

export type QueuedItemStatus = 'pending' | 'dead';

/** Delivery bookkeeping shared by every kind of item. */
export interface QueuedItemState {
  status: QueuedItemStatus;
  /**
   * Failures counted against the item. Only failures that happened while the
   * server was demonstrably answering are counted — an outage says nothing
   * about the item, and counting it is how the old queue gave up on data that
   * was perfectly fine.
   */
  attempts: number;
  /** Epoch ms before which this item must not be tried. */
  nextAttemptAt: number;
  lastError: string | null;
  /** Waiting for its session to be able to take it, not for the network. */
  parked: boolean;
  /**
   * Whether a request carrying this item was ever issued.
   *
   * An item that was never sent provably is not on the server, so it can be
   * re-homed to another session without any risk of storing it twice. One that
   * was sent might have landed with the response lost, so only the server may
   * say where it belongs.
   */
  everSent: boolean;
  /** When this client produced it. Lane and retention are judged from this. */
  producedAtMs: number;
  deadAt: number | null;
}

export interface QueuedSnapshotRecord extends QueuedItemState {
  /** Our idempotency key. Reused across every retry so the server dedupes. */
  clientSnapshotId: string;
  sessionId: string;
  project: string;
  /** When the frame was actually grabbed — never when it was uploaded. */
  capturedAt: string;
  blob: Blob;
  mimeType: string;
  fileSize: number;
  /**
   * A storage grant already used for this entry.
   *
   * Kept so a retry after a successful upload but a failed `complete` does not
   * upload the bytes again — only the confirmation is outstanding.
   */
  storageKey: string | null;
  uploaded: boolean;
}

export interface QueuedActivityRecord extends QueuedItemState {
  id?: number;
  sessionId: string;
  project: string;
  payload: MonitoringActivityPayload;
}

export type MonitoringEventKind =
  | 'inactivity-start'
  | 'inactivity-end'
  | 'pause'
  | 'resume'
  | 'stop';

export interface QueuedEventRecord extends QueuedItemState {
  /** Global insertion order. Events of one session are sent strictly in it. */
  seq?: number;
  sessionId: string;
  project: string;
  kind: MonitoringEventKind;
  /** The moment the event happened on this machine. */
  at: string;
  /** Stop only: pauses the server needs if it has to re-settle an expired session. */
  pauses?: MonitoringPauseInterval[];
}

export interface SyncSessionRecord {
  sessionId: string;
  /** The server has said this session no longer accepts live data. */
  closedRemotely: boolean;
  /** The session monitoring continued in after this one closed. */
  successorId: string | null;
  successorStartedAtMs: number | null;
  updatedAt: number;
}

// ─── Plumbing ─────────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Monitoring outbox request failed'));
  });
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Monitoring outbox transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Monitoring outbox transaction aborted'));
  });
}

/** Visit a cursor; return `false` from `visit` to stop early. */
function iterate<T>(
  source: IDBObjectStore | IDBIndex,
  query: IDBValidKey | IDBKeyRange | null,
  direction: IDBCursorDirection,
  visit: (value: T, cursor: IDBCursorWithValue) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorRequest = source.openCursor(query, direction);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (visit(cursor.value as T, cursor) === false) {
        resolve();
        return;
      }
      cursor.continue();
    };
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('Monitoring outbox cursor failed'));
  });
}

function ensureIndex(store: IDBObjectStore, name: string): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, name);
}

function upgrade(db: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  const snapshots = db.objectStoreNames.contains(SNAPSHOTS)
    ? transaction.objectStore(SNAPSHOTS)
    : db.createObjectStore(SNAPSHOTS, { keyPath: 'clientSnapshotId' });
  for (const legacy of ['capturedAt', 'nextAttemptAt']) {
    if (snapshots.indexNames.contains(legacy)) snapshots.deleteIndex(legacy);
  }
  ensureIndex(snapshots, 'producedAtMs');
  ensureIndex(snapshots, 'sessionId');
  ensureIndex(snapshots, 'status');

  if (oldVersion === 1) {
    // Every v1 entry marked 'failed' was failed by an attempt cap that gave up
    // after about half an hour of outage — not by anything wrong with the frame.
    // Each gets a fresh start; one the server genuinely refuses is now recognised
    // from the server's own answer.
    const cursorRequest = snapshots.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const legacy = cursor.value as Record<string, unknown>;
      const capturedMs = Date.parse(String(legacy.capturedAt));
      cursor.update({
        ...legacy,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        parked: false,
        everSent: true,
        producedAtMs: Number.isFinite(capturedMs) ? capturedMs : Date.now(),
        deadAt: null,
      });
      cursor.continue();
    };
  }

  if (!db.objectStoreNames.contains(ACTIVITIES)) {
    const activities = db.createObjectStore(ACTIVITIES, { keyPath: 'id', autoIncrement: true });
    ensureIndex(activities, 'producedAtMs');
    ensureIndex(activities, 'sessionId');
    ensureIndex(activities, 'status');
  }
  if (!db.objectStoreNames.contains(EVENTS)) {
    const events = db.createObjectStore(EVENTS, { keyPath: 'seq', autoIncrement: true });
    ensureIndex(events, 'sessionId');
    ensureIndex(events, 'status');
  }
  if (!db.objectStoreNames.contains(SESSIONS)) {
    db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
  }
}

function openQueueDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const openRequest = indexedDB.open(DB_NAME, DB_VERSION);
    openRequest.onupgradeneeded = (event) => {
      upgrade(openRequest.result, openRequest.transaction!, event.oldVersion);
    };
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      // Another context upgrading the schema must not be blocked by this handle.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    openRequest.onerror = () =>
      reject(openRequest.error ?? new Error('Could not open monitoring outbox'));
  }).catch((err: unknown) => {
    // Let a later call try again rather than caching a rejected promise forever —
    // a transient open failure would otherwise disable the outbox for the rest
    // of the worker's life.
    dbPromise = null;
    throw err;
  });
  dbPromise = opening;
  return opening;
}

async function read<T>(
  stores: string | string[],
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openQueueDb();
  return body(db.transaction(stores, 'readonly'));
}

/**
 * A read-write transaction.
 *
 * `body` may await IDB requests made on the same transaction — the transaction
 * stays open across those microtasks — but must not await anything else, or the
 * transaction commits underneath it.
 */
async function write(
  stores: string | string[],
  body: (transaction: IDBTransaction) => void | Promise<void>,
): Promise<void> {
  const db = await openQueueDb();
  const transaction = db.transaction(stores, 'readwrite');
  const done = settled(transaction);
  try {
    await body(transaction);
  } catch (err) {
    done.catch(() => {});
    try {
      transaction.abort();
    } catch {
      /* already finished */
    }
    throw err;
  }
  await done;
}

function freshState(producedAtMs: number): QueuedItemState {
  return {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    parked: false,
    everSent: false,
    producedAtMs,
    deadAt: null,
  };
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

/** Last measured size of the screenshot store, refreshed by maintenance. */
let knownSnapshotBytes = 0;

/**
 * Add a freshly captured frame.
 *
 * Enqueued *before* any upload is attempted, so a worker teardown, a crash or an
 * outage between capture and upload cannot lose the frame.
 */
export async function enqueueSnapshot(input: {
  clientSnapshotId: string;
  sessionId: string;
  project: string;
  capturedAt: string;
  blob: Blob;
  mimeType: string;
  fileSize: number;
}): Promise<void> {
  await enforceSnapshotBound();
  const capturedMs = Date.parse(input.capturedAt);
  const record: QueuedSnapshotRecord = {
    ...input,
    ...freshState(Number.isFinite(capturedMs) ? capturedMs : Date.now()),
    storageKey: null,
    uploaded: false,
  };
  await write(SNAPSHOTS, (transaction) => {
    transaction.objectStore(SNAPSHOTS).put(record);
  });
  knownSnapshotBytes += input.fileSize || 0;
}

/**
 * Keep the store inside its bounds by thinning, never by refusing new frames.
 *
 * Refusing to enqueue would turn a long outage into a monitoring blackout that
 * outlives it. Dead entries go first; after that, the densest stretch of old
 * frames is thinned so coverage of the outage survives at lower density rather
 * than losing its beginning outright.
 */
async function enforceSnapshotBound(): Promise<void> {
  const count = await read(SNAPSHOTS, (transaction) =>
    request(transaction.objectStore(SNAPSHOTS).count()),
  );
  const overCount = count + 1 - SYNC_POLICY.MAX_SNAPSHOTS;
  const overBytes = knownSnapshotBytes > SYNC_POLICY.MAX_SNAPSHOT_BYTES;
  if (overCount <= 0 && !overBytes) return;

  // Relief in chunks when the byte bound is hit, so it is not re-scanned on
  // every frame that follows.
  const drop = Math.max(overCount, overBytes ? Math.ceil(count * 0.05) : 0);

  const rows: Array<
    Pick<QueuedSnapshotRecord, 'clientSnapshotId' | 'status' | 'producedAtMs' | 'fileSize'>
  > = [];
  await read(SNAPSHOTS, (transaction) =>
    iterate<QueuedSnapshotRecord>(
      transaction.objectStore(SNAPSHOTS).index('producedAtMs'),
      null,
      'next',
      (entry) => {
        rows.push({
          clientSnapshotId: entry.clientSnapshotId,
          status: entry.status,
          producedAtMs: entry.producedAtMs,
          fileSize: entry.fileSize,
        });
      },
    ),
  );

  const victims = rows.filter((row) => row.status === 'dead').slice(0, drop);
  if (victims.length < drop) {
    const pending = rows.filter((row) => row.status !== 'dead');
    const picked = pickThinningVictims(
      pending.map((row) => row.producedAtMs),
      drop - victims.length,
      Date.now() - SYNC_POLICY.LIVE_WINDOW_MS,
    );
    victims.push(...picked.map((index) => pending[index]));
  }
  if (victims.length === 0) return;

  await write(SNAPSHOTS, (transaction) => {
    const store = transaction.objectStore(SNAPSHOTS);
    victims.forEach((victim) => store.delete(victim.clientSnapshotId));
  });
  knownSnapshotBytes = Math.max(
    0,
    knownSnapshotBytes - victims.reduce((sum, victim) => sum + (victim.fileSize || 0), 0),
  );
  console.warn(
    `[Monitoring] Outbox over its bound — thinned ${victims.length} of ${count} screenshot(s)`,
  );
}

/**
 * Screenshots due for an attempt in one lane.
 *
 * Live is newest first — the frame just taken is the one a viewer is waiting
 * for. Backlog is oldest first, so a recovered day fills in the order it
 * happened.
 */
export function nextSnapshots(options: {
  lane: SyncLane;
  now: number;
  limit: number;
}): Promise<QueuedSnapshotRecord[]> {
  return nextDue<QueuedSnapshotRecord>(
    SNAPSHOTS,
    options,
    options.lane === 'live' ? 'prev' : 'next',
  );
}

export async function getSnapshot(clientSnapshotId: string): Promise<QueuedSnapshotRecord | null> {
  const entry = await read(SNAPSHOTS, (transaction) =>
    request<QueuedSnapshotRecord | undefined>(
      transaction.objectStore(SNAPSHOTS).get(clientSnapshotId),
    ),
  );
  return entry ?? null;
}

export async function patchSnapshot(
  clientSnapshotId: string,
  patch: Partial<QueuedSnapshotRecord>,
): Promise<void> {
  await write(SNAPSHOTS, async (transaction) => {
    const store = transaction.objectStore(SNAPSHOTS);
    const entry = await request<QueuedSnapshotRecord | undefined>(store.get(clientSnapshotId));
    if (entry) store.put({ ...entry, ...patch });
  });
}

/** Done — drop the entry and its blob. */
export async function removeSnapshot(clientSnapshotId: string): Promise<void> {
  await write(SNAPSHOTS, (transaction) => {
    transaction.objectStore(SNAPSHOTS).delete(clientSnapshotId);
  });
}

// ─── Activities ───────────────────────────────────────────────────────────────

export async function enqueueActivity(
  sessionId: string,
  project: string,
  payload: MonitoringActivityPayload,
): Promise<void> {
  await enforceRowBound(ACTIVITIES, SYNC_POLICY.MAX_ACTIVITIES);
  const record: QueuedActivityRecord = { ...freshState(Date.now()), sessionId, project, payload };
  await write(ACTIVITIES, (transaction) => {
    transaction.objectStore(ACTIVITIES).add(record);
  });
}

/** Activity rows due for an attempt in one lane, oldest first. */
export function nextActivities(options: {
  lane: SyncLane;
  now: number;
  limit: number;
}): Promise<QueuedActivityRecord[]> {
  return nextDue<QueuedActivityRecord>(ACTIVITIES, options, 'next');
}

export async function patchActivities(records: QueuedActivityRecord[]): Promise<void> {
  if (records.length === 0) return;
  await write(ACTIVITIES, (transaction) => {
    const store = transaction.objectStore(ACTIVITIES);
    records.forEach((record) => store.put(record));
  });
}

export async function removeActivities(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await write(ACTIVITIES, (transaction) => {
    const store = transaction.objectStore(ACTIVITIES);
    ids.forEach((id) => store.delete(id));
  });
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function enqueueEvent(input: {
  sessionId: string;
  project: string;
  kind: MonitoringEventKind;
  at: string;
  pauses?: MonitoringPauseInterval[];
}): Promise<void> {
  await enforceRowBound(EVENTS, SYNC_POLICY.MAX_EVENTS);
  const record: QueuedEventRecord = { ...freshState(Date.now()), ...input };
  await write(EVENTS, (transaction) => {
    transaction.objectStore(EVENTS).add(record);
  });
}

/** Every pending event, in insertion order. Events are few, so this is cheap. */
export async function listPendingEvents(): Promise<QueuedEventRecord[]> {
  const events = await read(EVENTS, (transaction) =>
    request<QueuedEventRecord[]>(
      transaction.objectStore(EVENTS).index('status').getAll(IDBKeyRange.only('pending')),
    ),
  );
  return events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function patchEvent(seq: number, patch: Partial<QueuedEventRecord>): Promise<void> {
  await write(EVENTS, async (transaction) => {
    const store = transaction.objectStore(EVENTS);
    const entry = await request<QueuedEventRecord | undefined>(store.get(seq));
    if (entry) store.put({ ...entry, ...patch });
  });
}

export async function removeEvent(seq: number): Promise<void> {
  await write(EVENTS, (transaction) => {
    transaction.objectStore(EVENTS).delete(seq);
  });
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function getSyncSession(sessionId: string): Promise<SyncSessionRecord | null> {
  const record = await read(SESSIONS, (transaction) =>
    request<SyncSessionRecord | undefined>(transaction.objectStore(SESSIONS).get(sessionId)),
  );
  return record ?? null;
}

export async function updateSyncSession(
  sessionId: string,
  patch: Partial<Omit<SyncSessionRecord, 'sessionId'>>,
): Promise<void> {
  await write(SESSIONS, async (transaction) => {
    const store = transaction.objectStore(SESSIONS);
    const existing = await request<SyncSessionRecord | undefined>(store.get(sessionId));
    store.put({
      sessionId,
      closedRemotely: false,
      successorId: null,
      successorStartedAtMs: null,
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    } satisfies SyncSessionRecord);
  });
}

// ─── Cross-store ──────────────────────────────────────────────────────────────

const DATA_STORES = [SNAPSHOTS, ACTIVITIES, EVENTS];

/** Make every parked item of a session due now — something changed for it. */
export async function unparkSession(sessionId: string): Promise<void> {
  await write(DATA_STORES, async (transaction) => {
    for (const name of DATA_STORES) {
      await iterate<QueuedItemState>(
        transaction.objectStore(name).index('sessionId'),
        IDBKeyRange.only(sessionId),
        'next',
        (entry, cursor) => {
          if (entry.status === 'pending' && entry.parked) {
            cursor.update({ ...entry, parked: false, nextAttemptAt: 0 });
          }
        },
      );
    }
  });
}

/**
 * Move never-sent items produced from `fromMs` on to another session.
 *
 * Used when monitoring continues in a new server session. Only items that were
 * never sent move: those provably are not stored anywhere, so moving them cannot
 * store anything twice. Anything that was sent stays and lets the server's
 * answer decide. A stop never moves — it belongs to the session it ends.
 */
export async function retagSession(
  fromSessionId: string,
  toSessionId: string,
  fromMs: number,
): Promise<number> {
  let moved = 0;
  await write(DATA_STORES, async (transaction) => {
    await iterate<QueuedSnapshotRecord>(
      transaction.objectStore(SNAPSHOTS).index('sessionId'),
      IDBKeyRange.only(fromSessionId),
      'next',
      (entry, cursor) => {
        if (entry.status !== 'pending' || entry.everSent || entry.producedAtMs < fromMs) return;
        cursor.update({ ...entry, sessionId: toSessionId, storageKey: null, uploaded: false });
        moved++;
      },
    );
    await iterate<QueuedActivityRecord>(
      transaction.objectStore(ACTIVITIES).index('sessionId'),
      IDBKeyRange.only(fromSessionId),
      'next',
      (entry, cursor) => {
        if (entry.status !== 'pending' || entry.everSent) return;
        if (Date.parse(entry.payload.startedAt) < fromMs) return;
        cursor.update({ ...entry, sessionId: toSessionId });
        moved++;
      },
    );
    await iterate<QueuedEventRecord>(
      transaction.objectStore(EVENTS).index('sessionId'),
      IDBKeyRange.only(fromSessionId),
      'next',
      (entry, cursor) => {
        if (entry.status !== 'pending' || entry.everSent || entry.kind === 'stop') return;
        if (Date.parse(entry.at) < fromMs) return;
        cursor.update({ ...entry, sessionId: toSessionId });
        moved++;
      },
    );
  });
  return moved;
}

/**
 * Work the stop of `sessionId` should wait for: pending events plus live data.
 *
 * Backlog is deliberately excluded — see STOP_HOLD_MS.
 */
export async function sessionLiveWork(sessionId: string, now: number): Promise<number> {
  const liveFrom = now - SYNC_POLICY.LIVE_WINDOW_MS;
  let work = 0;
  await read(DATA_STORES, async (transaction) => {
    for (const name of DATA_STORES) {
      await iterate<QueuedItemState & { kind?: MonitoringEventKind }>(
        transaction.objectStore(name).index('sessionId'),
        IDBKeyRange.only(sessionId),
        'next',
        (entry) => {
          if (entry.status !== 'pending' || entry.parked) return;
          if (name === EVENTS ? entry.kind !== 'stop' : entry.producedAtMs >= liveFrom) work++;
        },
      );
    }
  });
  return work;
}

// ─── Stats and upkeep ─────────────────────────────────────────────────────────

export interface OutboxStats {
  pendingSnapshots: number;
  deadSnapshots: number;
  pendingActivities: number;
  deadActivities: number;
  pendingEvents: number;
  /** Oldest item still waiting, of any kind. */
  oldestPendingAtMs: number | null;
  snapshotBytes: number;
}

export async function outboxStats(): Promise<OutboxStats> {
  return read(DATA_STORES, async (transaction) => {
    const count = (name: string, status: QueuedItemStatus) =>
      request(transaction.objectStore(name).index('status').count(IDBKeyRange.only(status)));

    const oldest = async (name: string): Promise<number | null> => {
      let found: number | null = null;
      const source =
        name === EVENTS
          ? transaction.objectStore(name)
          : transaction.objectStore(name).index('producedAtMs');
      await iterate<QueuedItemState>(source, null, 'next', (entry) => {
        if (entry.status !== 'pending') return true;
        found = entry.producedAtMs;
        return false;
      });
      return found;
    };

    const [pendingSnapshots, deadSnapshots, pendingActivities, deadActivities, pendingEvents] =
      await Promise.all([
        count(SNAPSHOTS, 'pending'),
        count(SNAPSHOTS, 'dead'),
        count(ACTIVITIES, 'pending'),
        count(ACTIVITIES, 'dead'),
        count(EVENTS, 'pending'),
      ]);
    const oldestTimes = (
      await Promise.all([oldest(SNAPSHOTS), oldest(ACTIVITIES), oldest(EVENTS)])
    ).filter((value): value is number => value != null);

    return {
      pendingSnapshots,
      deadSnapshots,
      pendingActivities,
      deadActivities,
      pendingEvents,
      oldestPendingAtMs: oldestTimes.length > 0 ? Math.min(...oldestTimes) : null,
      snapshotBytes: knownSnapshotBytes,
    };
  });
}

/**
 * Periodic upkeep: re-measure the store, expire what can never be delivered,
 * and purge dead entries once they have been kept long enough to inspect.
 */
export async function maintainOutbox(now = Date.now()): Promise<void> {
  let bytes = 0;
  await write(DATA_STORES, async (transaction) => {
    for (const name of DATA_STORES) {
      await iterate<QueuedItemState & { fileSize?: number }>(
        transaction.objectStore(name),
        null,
        'next',
        (entry, cursor) => {
          if (entry.status === 'dead') {
            if (entry.deadAt != null && now - entry.deadAt > SYNC_POLICY.DEAD_RETENTION_MS) {
              cursor.delete();
              return;
            }
          } else if (
            (entry.parked || entry.attempts >= SYNC_POLICY.MAX_ATTEMPTS_WHILE_REACHABLE) &&
            now - entry.producedAtMs > SYNC_POLICY.PARKED_MAX_AGE_MS
          ) {
            cursor.update({
              ...entry,
              status: 'dead',
              deadAt: now,
              lastError: `No session would accept this after ${Math.round(
                SYNC_POLICY.PARKED_MAX_AGE_MS / 3_600_000,
              )}h: ${entry.lastError ?? 'session closed'}`,
            });
          }
          if (name === SNAPSHOTS) bytes += entry.fileSize || 0;
        },
      );
    }
  });
  knownSnapshotBytes = bytes;
}

/** Bound a row store by dropping its oldest dead rows, then its oldest pending ones. */
async function enforceRowBound(name: string, max: number): Promise<void> {
  const count = await read(name, (transaction) => request(transaction.objectStore(name).count()));
  if (count < max) return;
  let overBy = count - max + 1;
  let dropped = 0;
  await write(name, async (transaction) => {
    const store = transaction.objectStore(name);
    for (const status of ['dead', 'pending'] as const) {
      if (overBy <= 0) break;
      await iterate<QueuedItemState>(
        store.index('status'),
        IDBKeyRange.only(status),
        'next',
        (_, cursor) => {
          if (overBy <= 0) return false;
          cursor.delete();
          overBy--;
          dropped++;
          return true;
        },
      );
    }
  });
  console.warn(`[Monitoring] Outbox ${name} over its bound — dropped ${dropped} oldest row(s)`);
}

function nextDue<T extends QueuedItemState>(
  name: string,
  options: { lane: SyncLane; now: number; limit: number },
  direction: IDBCursorDirection,
): Promise<T[]> {
  const boundary = options.now - SYNC_POLICY.LIVE_WINDOW_MS;
  const range =
    options.lane === 'live'
      ? IDBKeyRange.lowerBound(boundary)
      : IDBKeyRange.upperBound(boundary, true);
  return read(name, async (transaction) => {
    const picked: T[] = [];
    if (options.limit <= 0) return picked;
    await iterate<T>(
      transaction.objectStore(name).index('producedAtMs'),
      range,
      direction,
      (entry) => {
        if (entry.status === 'pending' && entry.nextAttemptAt <= options.now) picked.push(entry);
        return picked.length < options.limit;
      },
    );
    return picked;
  });
}
