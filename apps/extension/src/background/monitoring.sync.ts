/**
 * Monitoring sync — the one path by which monitoring data reaches the server.
 *
 * Everything monitoring produces — screenshots, activity rows, inactivity,
 * pause, resume, stop — is written to the IndexedDB outbox first
 * (`utils/monitoringQueue.ts`) and sent from here. Nothing is sent inline.
 *
 * ── Outage: stop asking, keep everything ─────────────────────────────────────
 * The first request that fails because the server is unreachable marks the
 * server offline. From then on no data is sent at all — just one probe at a
 * time on a 30s → 5min backoff — so a client does not spend an outage hammering
 * a backend that is trying to come back. Failures during an outage are never
 * counted against the data: nothing is discarded for failing to reach a server
 * that was not there.
 *
 * ── Recovery: live first, backlog gradually ──────────────────────────────────
 * Items are in one of two lanes by age. Live items — the last few minutes —
 * go immediately, exactly as if nothing had happened. The backlog goes up in
 * small batches two to three minutes apart, oldest first, and the first batch
 * waits a random 15–60s after recovery so every client that lost the server at
 * the same moment does not return in the same second. Four hours of 30-second
 * screenshots is about an hour of trickle, at a few requests a minute on top of
 * the live load.
 *
 * ── Duplicates ───────────────────────────────────────────────────────────────
 * Every item carries an idempotency key the server dedupes on
 * (`clientSnapshotId`, `clientActivityId`), an item is deleted only after the
 * server confirms it, and inactivity/lifecycle calls are idempotent server-side.
 * A retry after a lost response therefore lands as a duplicate the server
 * ignores, never as a second row. Draining is single-flight, so the same item
 * is never in two requests at once.
 *
 * ── A session that closed underneath its data ────────────────────────────────
 * After a long enough silence the server expires the session, and a midnight
 * rollover completes one. The server's answer to data for such a session is
 * MONITORING_SESSION_NOT_ACTIVE, and that is handled rather than dropped: the
 * item moves to the session monitoring continued in if it belongs there, and is
 * otherwise parked while the manager re-settles the old session (see
 * `continueAfterRemoteClose` in the manager) — after which it is retried.
 */

import {
  requestSnapshotUpload,
  uploadSnapshotBytes,
  uploadSnapshotBytesViaApi,
  completeSnapshot,
  sendActivityBatch,
  startInactivity,
  endInactivity,
  pauseMonitoring,
  resumeMonitoring,
  stopMonitoring,
  MonitoringApiError,
} from '@/services/monitoring.api';
import {
  nextSnapshots,
  patchSnapshot,
  removeSnapshot,
  nextActivities,
  patchActivities,
  removeActivities,
  listPendingEvents,
  patchEvent,
  removeEvent,
  getSyncSession,
  updateSyncSession,
  unparkSession,
  sessionLiveWork,
  outboxStats,
  maintainOutbox,
  type OutboxStats,
  type QueuedActivityRecord,
  type QueuedEventRecord,
  type QueuedItemState,
  type QueuedSnapshotRecord,
  type SyncSessionRecord,
} from '@/utils/monitoringQueue';
import {
  SYNC_POLICY,
  backlogDelayMs,
  classifyFailure,
  haltsSync,
  itemBackoffMs,
  parseBatchErrors,
  probeDelayMs,
  recoveryDelayMs,
  successorFor,
  type FailureKind,
  type SyncLane,
} from '@/utils/monitoringSyncPolicy';
import {
  ACTIVITY_BATCH_MAX,
  MONITORING_ALARMS,
  MONITORING_STORAGE_KEYS,
  type ActivityBatchResponse,
} from '@/types/monitoring';

/** Live-lane retry cadence while the worker is awake. */
const SWEEP_INTERVAL_MS = 15_000;

/** How often the outbox is re-measured and aged. */
const MAINTAIN_INTERVAL_MS = 10 * 60_000;

// ─── Hooks ────────────────────────────────────────────────────────────────────

export interface SyncStatus extends OutboxStats {
  offlineSince: string | null;
  lastError: string | null;
}

interface SyncHooks {
  /** Outbox depth or server reachability changed; the popup shows this. */
  onStatus: (status: SyncStatus) => void | Promise<void>;
  /** One screenshot is confirmed stored. */
  onSnapshotStored: (sessionId: string, capturedAt: string) => void | Promise<void>;
  /** The server has just said this session no longer accepts data. */
  onSessionClosed: (sessionId: string) => void | Promise<void>;
}

let hooks: SyncHooks | null = null;

export function configureSync(next: SyncHooks): void {
  hooks = next;
}

// ─── Server reachability ──────────────────────────────────────────────────────

interface SyncHealth {
  offlineSince: string | null;
  consecutiveFailures: number;
  /** While offline: nothing is sent before this, and then only one probe. */
  nextProbeAt: number;
  /** Nothing from the backlog is sent before this. */
  nextBacklogAt: number;
  lastError: string | null;
}

const INITIAL_HEALTH: SyncHealth = {
  offlineSince: null,
  consecutiveFailures: 0,
  nextProbeAt: 0,
  nextBacklogAt: 0,
  lastError: null,
};

/**
 * Cached, and persisted on change.
 *
 * Persisted because a worker woken by the alarm must know it is mid-outage —
 * otherwise every wake-up would forget the backoff and send a full pass at a
 * server that is still down.
 */
let health: SyncHealth | null = null;

async function loadHealth(): Promise<SyncHealth> {
  if (health) return health;
  try {
    const stored = await chrome.storage.local.get([MONITORING_STORAGE_KEYS.SYNC_HEALTH]);
    health = {
      ...INITIAL_HEALTH,
      ...((stored[MONITORING_STORAGE_KEYS.SYNC_HEALTH] as Partial<SyncHealth> | undefined) ?? {}),
    };
  } catch {
    health = { ...INITIAL_HEALTH };
  }
  return health;
}

async function saveHealth(next: SyncHealth): Promise<void> {
  health = next;
  try {
    await chrome.storage.local.set({ [MONITORING_STORAGE_KEYS.SYNC_HEALTH]: next });
  } catch {
    /* kept in memory; the next save retries */
  }
}

interface Pass {
  now: number;
  /** Requests this pass may still make. One while probing an offline server. */
  budget: number;
  sends: number;
  halted: boolean;
  /** The server gave a real answer during this pass. */
  sawAnswer: boolean;
  backlogTouched: boolean;
}

function exhausted(pass: Pass): boolean {
  return pass.halted || pass.sends >= pass.budget;
}

/** The server answered — a success, or a verdict of its own. */
async function recordAnswer(pass?: Pass): Promise<void> {
  if (pass) {
    pass.sawAnswer = true;
    pass.budget = Number.POSITIVE_INFINITY;
  }
  const current = await loadHealth();
  if (!current.offlineSince && current.consecutiveFailures === 0) return;

  const recovering = Boolean(current.offlineSince);
  await saveHealth({
    ...current,
    offlineSince: null,
    consecutiveFailures: 0,
    nextProbeAt: 0,
    lastError: null,
    nextBacklogAt: recovering ? Date.now() + recoveryDelayMs() : current.nextBacklogAt,
  });
  if (recovering) {
    console.log(
      '[Monitoring] server reachable again — live data resumes now, backlog follows gradually',
    );
  }
}

async function recordOutage(kind: FailureKind, message: string, pass?: Pass): Promise<void> {
  if (pass) pass.halted = true;
  const current = await loadHealth();
  const consecutiveFailures = current.consecutiveFailures + 1;
  const delay =
    kind === 'throttled' ? SYNC_POLICY.THROTTLE_BACKOFF_MS : probeDelayMs(consecutiveFailures);
  if (!current.offlineSince) {
    console.warn(
      `[Monitoring] server unavailable (${message}) — saving data locally until it returns`,
    );
  }
  await saveHealth({
    ...current,
    offlineSince: current.offlineSince ?? new Date().toISOString(),
    consecutiveFailures,
    nextProbeAt: Date.now() + delay,
    lastError: describeOutage(kind),
  });
}

function describeOutage(kind: FailureKind): string {
  switch (kind) {
    case 'auth':
      return 'Your BestQ sign-in has expired. Monitoring data is saved on this computer and will upload once you sign in again.';
    case 'throttled':
      return 'The server asked for fewer requests. Saved monitoring data will continue uploading shortly.';
    default:
      return 'The BestQ server cannot be reached. Monitoring data is saved on this computer and will upload automatically when it is back.';
  }
}

/** For the heartbeat, which is the natural probe while a session is live. */
export async function noteServerReachable(): Promise<void> {
  await recordAnswer();
}

export async function noteServerUnreachable(err: unknown): Promise<void> {
  const kind = kindOf(err);
  if (haltsSync(kind)) await recordOutage(kind, messageOf(err));
}

function kindOf(err: unknown): FailureKind {
  // Anything that is not an API answer — a fetch that threw before wrapping, an
  // IndexedDB hiccup — is treated as transient. Guessing "permanent" would
  // destroy data; guessing "transient" only costs a retry.
  if (!(err instanceof MonitoringApiError)) return 'transient';
  return classifyFailure({ status: err.status, code: err.code });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Item outcomes ────────────────────────────────────────────────────────────

function retryLater<T extends QueuedItemState>(entry: T, message: string, counted: boolean): T {
  const attempts = counted ? entry.attempts + 1 : entry.attempts;
  return {
    ...entry,
    attempts,
    everSent: true,
    lastError: message.slice(0, 300),
    nextAttemptAt:
      Date.now() + (counted ? itemBackoffMs(attempts) : SYNC_POLICY.UNCOUNTED_RETRY_MS),
  };
}

function park<T extends QueuedItemState>(entry: T, message: string): T {
  return {
    ...entry,
    everSent: true,
    parked: true,
    lastError: message.slice(0, 300),
    nextAttemptAt: Date.now() + SYNC_POLICY.PARK_RETRY_MS,
  };
}

function kill<T extends QueuedItemState>(entry: T, message: string): T {
  return { ...entry, status: 'dead', deadAt: Date.now(), lastError: message.slice(0, 300) };
}

async function noteSessionClosed(
  sessionId: string,
  session: SyncSessionRecord | null,
): Promise<void> {
  if (session?.closedRemotely) return;
  await updateSyncSession(sessionId, { closedRemotely: true });
  console.warn(`[Monitoring] session ${sessionId} no longer accepts data — re-settling it`);
  void Promise.resolve(hooks?.onSessionClosed(sessionId)).catch(() => {});
}

type Outcome = 'done' | 'retry' | 'parked' | 'halted';

/** The failure paths every kind of item shares. */
async function settleFailure<T extends QueuedItemState>(context: {
  entry: T;
  err: unknown;
  pass: Pass;
  /** An earlier step of this same attempt got an answer from the server. */
  answered: boolean;
  sessionId: string;
  producedAtMs: number;
  save: (next: T) => Promise<void>;
  remove: () => Promise<void>;
  rehome: (successorId: string) => Promise<void>;
}): Promise<Outcome> {
  const { entry, err, pass } = context;
  const kind = kindOf(err);
  const message = messageOf(err);

  switch (kind) {
    case 'duplicate':
      await recordAnswer(pass);
      await context.remove();
      return 'done';

    case 'session-closed': {
      await recordAnswer(pass);
      const session = await getSyncSession(context.sessionId);
      const successor = successorFor(session, context.producedAtMs);
      if (successor) {
        await context.rehome(successor);
        return 'done';
      }
      await context.save(park(entry, message));
      await noteSessionClosed(context.sessionId, session);
      return 'parked';
    }

    case 'rejected':
      await recordAnswer(pass);
      console.warn('[Monitoring] the server refused an item permanently:', message);
      await context.save(kill(entry, message));
      return 'done';

    case 'unrecognised':
      await context.save(park(entry, message));
      return 'parked';

    case 'transient':
    case 'throttled':
    case 'auth': {
      // The server answered other requests in this pass, so it is up — this
      // failure is about the item, and must not pause everything else.
      const itemLevel = kind === 'transient' && (context.answered || pass.sawAnswer);
      await context.save(retryLater(entry, message, itemLevel));
      if (itemLevel) return 'retry';
      await recordOutage(kind, message, pass);
      return 'halted';
    }

    default:
      await recordAnswer(pass);
      await context.save(retryLater(entry, message, true));
      return 'retry';
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Inactivity and lifecycle calls, strictly in order within each session.
 *
 * Order is load-bearing: an inactivity end sent before its start closes
 * nothing, and a pause sent after the stop is refused. So a session's chain
 * stops at the first event that cannot go yet.
 */
async function drainEvents(pass: Pass): Promise<void> {
  const events = await listPendingEvents();
  if (events.length === 0) return;

  const chains = new Map<string, QueuedEventRecord[]>();
  for (const event of events) {
    const chain = chains.get(event.sessionId);
    if (chain) chain.push(event);
    else chains.set(event.sessionId, [event]);
  }

  for (const [sessionId, chain] of chains) {
    if (exhausted(pass)) return;
    const session = await getSyncSession(sessionId);
    let sent = 0;

    while (chain.length > 0 && sent < SYNC_POLICY.EVENTS_PER_SESSION_PER_PASS) {
      if (exhausted(pass)) return;

      // A session the server closed is re-settled before anything else of it:
      // its stop is what re-opens the window the rest of its data lands in.
      const stopIndex = session?.closedRemotely ? chain.findIndex((e) => e.kind === 'stop') : -1;
      const index = stopIndex >= 0 ? stopIndex : 0;
      const head = chain[index];
      if (head.nextAttemptAt > pass.now) break;

      if (
        head.kind === 'stop' &&
        !session?.closedRemotely &&
        pass.now - head.producedAtMs < SYNC_POLICY.STOP_HOLD_MS &&
        (await sessionLiveWork(sessionId, pass.now)) > 0
      ) {
        break;
      }

      const outcome = await sendEvent(head, session, pass);
      if (outcome !== 'done') break;
      chain.splice(index, 1);
      sent++;
    }
  }
}

async function sendEvent(
  event: QueuedEventRecord,
  session: SyncSessionRecord | null,
  pass: Pass,
): Promise<Outcome> {
  const seq = event.seq!;
  if (!event.everSent) await patchEvent(seq, { everSent: true });

  try {
    switch (event.kind) {
      case 'inactivity-start':
        await startInactivity(event.project, event.sessionId, event.at);
        break;
      case 'inactivity-end':
        await endInactivity(event.project, event.sessionId, event.at);
        break;
      case 'pause':
        await pauseMonitoring(event.project, event.sessionId, event.at);
        break;
      case 'resume':
        await resumeMonitoring(event.project, event.sessionId, event.at);
        break;
      case 'stop':
        await stopMonitoring(event.project, event.sessionId, event.at, event.pauses ?? []);
        break;
    }
    await removeEvent(seq);
    pass.sends++;
    await recordAnswer(pass);
    // The re-settle just widened the session to the real stop, so everything
    // parked waiting for that can go now rather than at its next park retry.
    if (event.kind === 'stop' && session?.closedRemotely) await unparkSession(event.sessionId);
    return 'done';
  } catch (err) {
    const kind = kindOf(err);

    // Answers that mean the event already has its effect.
    if (kind === 'overlap' && event.kind === 'inactivity-start') {
      await recordAnswer(pass);
      await removeEvent(seq);
      return 'done';
    }
    if (kind === 'session-closed' && (event.kind === 'pause' || event.kind === 'resume')) {
      // Carried by the stop's `pauses`, which the server applies when it
      // re-settles the session.
      await recordAnswer(pass);
      await removeEvent(seq);
      await noteSessionClosed(event.sessionId, session);
      return 'done';
    }
    if (kind === 'inactivity-missing' && event.kind === 'inactivity-end') {
      await recordAnswer(pass);
      // A midnight rollover re-opens the period on the next day's session.
      const successor = successorFor(session, Date.parse(event.at));
      if (successor) await patchEvent(seq, { sessionId: successor });
      // Otherwise a pause, stop or expiry already closed it.
      else await removeEvent(seq);
      return 'done';
    }

    return settleFailure<QueuedEventRecord>({
      entry: { ...event, everSent: true },
      err,
      pass,
      answered: false,
      sessionId: event.sessionId,
      producedAtMs: Date.parse(event.at),
      save: (next) => patchEvent(seq, next),
      remove: () => removeEvent(seq),
      rehome: (successorId) => patchEvent(seq, { sessionId: successorId }),
    });
  }
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

async function drainSnapshots(lane: SyncLane, limit: number, pass: Pass): Promise<void> {
  if (exhausted(pass)) return;
  const due = await nextSnapshots({
    lane,
    now: pass.now,
    limit: Math.min(limit, pass.budget - pass.sends),
  });
  if (lane === 'backlog' && due.length > 0) pass.backlogTouched = true;
  for (const entry of due) {
    if (exhausted(pass)) return;
    await uploadSnapshot(entry, pass);
  }
}

/**
 * Grant, bytes, confirm.
 *
 * A worker torn down mid-upload is safe: the entry is removed only after the
 * server confirms, and a recorded successful upload resumes at the confirm step
 * instead of sending the bytes twice.
 */
async function uploadSnapshot(initial: QueuedSnapshotRecord, pass: Pass): Promise<void> {
  let entry = initial;
  let answered = false;
  if (!entry.everSent) {
    entry = { ...entry, everSent: true };
    await patchSnapshot(entry.clientSnapshotId, { everSent: true });
  }

  try {
    let storageKey = entry.storageKey;

    if (!entry.uploaded || !storageKey) {
      const grant = await requestSnapshotUpload(entry.project, entry.sessionId, {
        clientSnapshotId: entry.clientSnapshotId,
        capturedAt: entry.capturedAt,
        mimeType: entry.mimeType,
        fileSize: entry.fileSize,
      });
      answered = true;

      // PROXY means object storage has no browser-reachable HTTPS address, so
      // the bytes go through the API. An older server sends no strategy at all,
      // and that only ever meant DIRECT.
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
          // unreachable host, mixed content, a blocked private-network request.
          // That is a property of the deployment, not of this frame, so the API
          // takes the bytes instead.
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
      entry = { ...entry, storageKey, uploaded: true };
      await patchSnapshot(entry.clientSnapshotId, { storageKey, uploaded: true });
    }

    await completeSnapshot(entry.project, entry.sessionId, {
      clientSnapshotId: entry.clientSnapshotId,
      storageKey,
      capturedAt: entry.capturedAt,
    });

    await removeSnapshot(entry.clientSnapshotId);
    pass.sends++;
    await recordAnswer(pass);
    await hooks?.onSnapshotStored(entry.sessionId, entry.capturedAt);
  } catch (err) {
    const id = entry.clientSnapshotId;
    const kind = kindOf(err);

    // The grant expired or storage lost the bytes: the upload has to start
    // over from a fresh grant rather than retrying a confirmation that cannot
    // succeed.
    const restart =
      kind === 'reservation-lost' ||
      (err instanceof MonitoringApiError && err.code === 'MONITORING_UPLOAD_FAILED');
    if (restart) entry = { ...entry, uploaded: false, storageKey: null };
    if (kind === 'reservation-lost') {
      await recordAnswer(pass);
      await patchSnapshot(id, { uploaded: false, storageKey: null, nextAttemptAt: 0 });
      return;
    }

    await settleFailure<QueuedSnapshotRecord>({
      entry,
      err,
      pass,
      answered,
      sessionId: entry.sessionId,
      producedAtMs: entry.producedAtMs,
      save: (next) => patchSnapshot(id, next),
      remove: () => removeSnapshot(id),
      // A grant is per session, so a re-homed frame starts its upload over.
      rehome: (successorId) =>
        patchSnapshot(id, { sessionId: successorId, uploaded: false, storageKey: null }),
    });
  }
}

// ─── Activities ───────────────────────────────────────────────────────────────

async function drainActivities(lane: SyncLane, limit: number, pass: Pass): Promise<void> {
  if (exhausted(pass)) return;
  const rows = await nextActivities({ lane, now: pass.now, limit });
  if (rows.length === 0) return;
  if (lane === 'backlog') pass.backlogTouched = true;

  const bySession = new Map<string, QueuedActivityRecord[]>();
  for (const row of rows) {
    const group = bySession.get(row.sessionId);
    if (group) group.push(row);
    else bySession.set(row.sessionId, [row]);
  }

  for (const group of bySession.values()) {
    for (let start = 0; start < group.length; start += ACTIVITY_BATCH_MAX) {
      if (exhausted(pass)) return;
      await sendActivityRows(group.slice(start, start + ACTIVITY_BATCH_MAX), pass);
    }
  }
}

/**
 * One batch request. Partial acceptance is the server's contract, so each row
 * gets its own outcome from the response.
 */
async function sendActivityRows(rows: QueuedActivityRecord[], pass: Pass): Promise<void> {
  const { sessionId, project } = rows[0];
  const unsent = rows.filter((row) => !row.everSent);
  if (unsent.length > 0) {
    unsent.forEach((row) => {
      row.everSent = true;
    });
    await patchActivities(unsent);
  }

  let response: ActivityBatchResponse | undefined;
  try {
    response = await sendActivityBatch(
      project,
      sessionId,
      rows.map((row) => row.payload),
    );
  } catch (err) {
    const kind = kindOf(err);
    const message = messageOf(err);

    if (kind === 'rejected' && rows.length > 1) {
      // One malformed row fails validation for the whole request. Halve until
      // it is alone, so it cannot take its neighbours down with it.
      await recordAnswer(pass);
      const middle = Math.ceil(rows.length / 2);
      await sendActivityRows(rows.slice(0, middle), pass);
      if (!exhausted(pass)) await sendActivityRows(rows.slice(middle), pass);
      return;
    }

    switch (kind) {
      case 'session-closed':
        await recordAnswer(pass);
        await rehomeOrPark(sessionId, rows, message);
        return;
      case 'rejected':
        await recordAnswer(pass);
        await patchActivities(rows.map((row) => kill(row, message)));
        return;
      case 'unrecognised':
        await patchActivities(rows.map((row) => park(row, message)));
        return;
      default: {
        const itemLevel = kind === 'transient' && pass.sawAnswer;
        await patchActivities(rows.map((row) => retryLater(row, message, itemLevel)));
        if (!itemLevel && haltsSync(kind)) await recordOutage(kind, message, pass);
        return;
      }
    }
  }

  pass.sends++;
  await recordAnswer(pass);

  const errors = parseBatchErrors(response?.errors);
  const done: number[] = [];
  const closed: QueuedActivityRecord[] = [];
  const refused: QueuedActivityRecord[] = [];
  for (const row of rows) {
    const reason = errors.get(row.payload.clientActivityId);
    if (!reason) done.push(row.id!);
    else if (reason.includes('MONITORING_SESSION_NOT_ACTIVE')) closed.push(row);
    else refused.push(kill(row, reason));
  }

  await removeActivities(done);
  if (refused.length > 0) {
    console.warn(
      `[Monitoring] the server refused ${refused.length} activity row(s):`,
      refused[0].lastError,
    );
    await patchActivities(refused);
  }
  if (closed.length > 0) await rehomeOrPark(sessionId, closed, 'MONITORING_SESSION_NOT_ACTIVE');
}

async function rehomeOrPark(
  sessionId: string,
  rows: QueuedActivityRecord[],
  message: string,
): Promise<void> {
  const session = await getSyncSession(sessionId);
  let parked = false;
  const updated = rows.map((row) => {
    const successor = successorFor(session, Date.parse(row.payload.startedAt));
    if (successor) return { ...row, sessionId: successor };
    parked = true;
    return park(row, message);
  });
  await patchActivities(updated);
  if (parked) await noteSessionClosed(sessionId, session);
}

// ─── Driving it ───────────────────────────────────────────────────────────────

/**
 *   live   a frame was just queued — events and live screenshots
 *   sweep  periodic retry while the worker is awake
 *   tick   the minute alarm — also activity, which is batched per minute
 *   flush  a stop is waiting — live data and events, never backlog
 */
export type DrainReason = 'live' | 'sweep' | 'tick' | 'flush';

const REASON_WEIGHT: Record<DrainReason, number> = { sweep: 0, live: 1, flush: 2, tick: 3 };

let running: Promise<void> | null = null;
let queuedReason: DrainReason | null = null;

/**
 * Send what is due.
 *
 * Single-flight: a call while a pass runs is folded into one follow-up pass
 * instead of starting a second drainer that could send the same item twice.
 */
export function drainSync(reason: DrainReason = 'live'): Promise<void> {
  if (running) {
    if (!queuedReason || REASON_WEIGHT[reason] > REASON_WEIGHT[queuedReason]) queuedReason = reason;
    return running;
  }
  running = (async () => {
    let next: DrainReason | null = reason;
    while (next) {
      queuedReason = null;
      await runPass(next);
      next = queuedReason;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

async function runPass(reason: DrainReason): Promise<void> {
  try {
    const current = await loadHealth();
    const now = Date.now();
    if (current.offlineSince && now < current.nextProbeAt) return;

    const pass: Pass = {
      now,
      budget: current.offlineSince ? 1 : Number.POSITIVE_INFINITY,
      sends: 0,
      halted: false,
      sawAnswer: false,
      backlogTouched: false,
    };

    await drainEvents(pass);
    await drainSnapshots('live', SYNC_POLICY.LIVE_SNAPSHOTS_PER_PASS, pass);
    if (reason === 'tick' || reason === 'flush') {
      await drainActivities('live', ACTIVITY_BATCH_MAX, pass);
    }

    // The backlog never goes while probing, never while a stop is waiting on
    // this pass, and only on its paced schedule.
    const paced = await loadHealth();
    if (
      reason !== 'flush' &&
      !exhausted(pass) &&
      !paced.offlineSince &&
      now >= paced.nextBacklogAt
    ) {
      await drainSnapshots('backlog', SYNC_POLICY.BACKLOG_SNAPSHOTS_PER_BATCH, pass);
      await drainActivities('backlog', SYNC_POLICY.BACKLOG_ACTIVITIES_PER_BATCH, pass);
      if (pass.backlogTouched) {
        await saveHealth({ ...(await loadHealth()), nextBacklogAt: Date.now() + backlogDelayMs() });
      }
    }
  } catch (err) {
    console.warn('[Monitoring] sync pass failed:', err);
  } finally {
    await publish();
  }
}

let lastPublished = '';
let alarmArmed: boolean | null = null;

async function publish(): Promise<void> {
  try {
    const stats = await outboxStats();
    const current = await loadHealth();
    const pending = stats.pendingSnapshots + stats.pendingActivities + stats.pendingEvents;
    await scheduleAlarm(pending > 0);

    const status: SyncStatus = {
      ...stats,
      offlineSince: current.offlineSince,
      lastError: current.lastError,
    };
    const { snapshotBytes: _bytes, ...visible } = status;
    const fingerprint = JSON.stringify(visible);
    if (fingerprint === lastPublished) return;
    lastPublished = fingerprint;
    await hooks?.onStatus(status);
  } catch {
    /* the outbox is unreadable right now; the next pass publishes */
  }
}

/**
 * Keep the sync alarm armed exactly while there is something to send.
 *
 * Touches `chrome.alarms` only on a change: every extension API call extends the
 * worker's life, and calling one on every sweep would keep an idle worker alive
 * indefinitely.
 */
async function scheduleAlarm(hasWork: boolean): Promise<void> {
  if (hasWork === alarmArmed) return;
  try {
    if (hasWork) {
      const existing = await chrome.alarms.get(MONITORING_ALARMS.SYNC);
      if (!existing) await chrome.alarms.create(MONITORING_ALARMS.SYNC, { periodInMinutes: 1 });
    } else {
      await chrome.alarms.clear(MONITORING_ALARMS.SYNC);
    }
    alarmArmed = hasWork;
  } catch {
    /* retried on the next publish */
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Faster live-lane retries while a session is running and the worker is awake. */
export function startSyncSweep(): void {
  if (!sweepTimer) sweepTimer = setInterval(() => void drainSync('sweep'), SWEEP_INTERVAL_MS);
  void drainSync('sweep');
}

export function stopSyncSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

let lastMaintainedAt = 0;

/** The sync alarm: drain, and now and then tidy the outbox. */
export async function handleSyncAlarm(): Promise<void> {
  await drainSync('tick');
  if (Date.now() - lastMaintainedAt < MAINTAIN_INTERVAL_MS) return;
  lastMaintainedAt = Date.now();
  try {
    await maintainOutbox();
  } catch (err) {
    console.warn('[Monitoring] outbox maintenance failed:', err);
  }
}

/**
 * Give a stopping session's live data and its stop a bounded chance to land.
 *
 * Bounded by a deadline and a no-progress check: an unreachable server must not
 * hold the stop open. Whatever is left stays in the outbox and keeps going.
 */
export async function flushSessionSync(sessionId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = Number.POSITIVE_INFINITY;

  while (Date.now() < deadline) {
    if ((await loadHealth()).offlineSince) return;
    const stopPending = (await listPendingEvents()).some(
      (event) => event.sessionId === sessionId && event.kind === 'stop' && !event.parked,
    );
    const work = (await sessionLiveWork(sessionId, Date.now())) + (stopPending ? 1 : 0);
    if (work === 0 || work >= previous) return;
    previous = work;
    await drainSync('flush');
  }
}
