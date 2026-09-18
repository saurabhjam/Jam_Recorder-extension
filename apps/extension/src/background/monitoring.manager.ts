/**
 * Screen monitoring — the one authoritative session lifecycle.
 *
 * ── The popup does not own monitoring ────────────────────────────────────────
 * Every piece of session state lives here and in `chrome.storage.local`. The
 * popup sends intents and renders what it is told, so closing it — which
 * happens the instant the user clicks anywhere else — cannot disturb a running
 * session.
 *
 * ── Nothing here may rely on the worker staying alive ────────────────────────
 * An MV3 worker is torn down after ~30s idle; a session runs for hours. So
 * in-memory state is re-read from storage at the top of every entry point, and
 * everything periodic is driven by `chrome.alarms`, which Chrome guarantees
 * will wake a stopped worker. The one-minute alarm floor is why the alarm does
 * bookkeeping (heartbeat, activity flush, capture watchdog) while the native
 * agent — which is NOT torn down — drives the 30/60s capture cadence.
 *
 * ── Nothing is sent inline, and nothing waits for the server ─────────────────
 * Every write — screenshots, activity, inactivity, pause, resume, stop — goes
 * into the durable outbox first and is delivered by `monitoring.sync.ts`. A
 * session behaves the same whether the server is up, down for a minute or down
 * for a morning; only how soon the server hears about it changes. The only
 * direct calls left are `start`, which has to return a session id, and the
 * heartbeat, which is a liveness signal with nothing to replay.
 *
 * ── Session state and capture state are separate ─────────────────────────────
 * They fail independently. A session can be perfectly alive on the server while
 * the screen stream is dead, and reporting only the former is what let the UI
 * claim "Monitoring Active" with no screenshots for an hour. Both are tracked
 * and both are published.
 *
 * ── Inactivity is checked against the OS every minute ────────────────────────
 * Idle events from the agent and from `chrome.idle` are hints. Every decision
 * about opening or closing a period is made in `utils/monitoringInactivity.ts`,
 * one at a time, and a minute-by-minute reconcile compares the open period with
 * the OS's own idle counter — so a lost "idle ended", which once left people
 * "inactive" for the rest of a session they were working through, is corrected
 * within a minute whatever the cause. Sixty minutes of continuous inactivity
 * stops the session on its own.
 */

import { generateId } from '@/utils';
import {
  INITIAL_MONITORING_STATE,
  INACTIVITY_THRESHOLD_SECONDS,
  MONITORING_ALARMS,
  MONITORING_STORAGE_KEYS,
  type CaptureHealth,
  type MonitoringInterval,
  type MonitoringPauseInterval,
  type MonitoringState,
  type NativeAgentState,
  type NativeActivity,
  type NativeIdleEvent,
  type StartMonitoringResponse,
} from '@/types/monitoring';
import {
  startMonitoring as apiStart,
  stopMonitoring as apiStop,
  fetchMonitoringSession,
  sendHeartbeat,
  getMonitoringProject,
  setMonitoringProject,
  MonitoringApiError,
} from '@/services/monitoring.api';
import {
  enqueueActivity,
  enqueueEvent,
  enqueueSnapshot,
  listPendingEvents,
  retagSession,
  unparkSession,
  updateSyncSession,
  type MonitoringEventKind,
} from '@/utils/monitoringQueue';
import {
  currentRunStartMs,
  extendLiveness,
  settledEndMs,
  type LivenessSegment,
} from '@/utils/monitoringSyncPolicy';
import {
  INACTIVITY_POLICY,
  agentIdleStarted,
  autoStopAt,
  awayStopAt,
  browserIdleChanged,
  idleBoundsFromProbes,
  idleEnded,
  parseLiveSessionId,
  probeLadder,
  reconcileInactivity,
  type IdleBounds,
  type InactivityDecision,
  type InactivityTracker,
  type OsIdleState,
} from '@/utils/monitoringInactivity';
import { getAssignedProjects, resolveDefaultProject } from '@/services/projects';
import {
  configureSync,
  deliverSessionEvents,
  drainSync,
  flushSessionSync,
  handleSyncAlarm,
  noteServerReachable,
  noteServerUnreachable,
  sessionsAwaitingStop,
  startSyncSweep,
  stopSyncSweep,
  type SyncStatus,
} from './monitoring.sync';
import {
  startCapture,
  stopCapture,
  noteFrameCaptured,
  noteFrameFailed,
  getCaptureHealth,
  setCaptureHealth,
  resetCaptureHealth,
  isCaptureStale,
} from './monitoring.capture';
import {
  configureNativeAgent,
  connectNativeAgent,
  startNativeMonitoring,
  waitForNativeAgent,
  stopNativeMonitoring,
  pauseNativeAgent,
  resumeNativeAgent,
  flushNativeAgent,
  isNativeAgentTracking,
  nativeOwnsIdleDetection,
  recoverNativeAgentIfStale,
  getNativeAgentState,
} from './native-agent.manager';
import {
  noteActivePage as noteActivePageInternal,
  initializeCurrentActivity,
  closeOpenActivity,
  recordNativeInterval,
  clearActivityState,
  currentActivityLabel,
  configureActivitySink,
  takeLegacyActivityBuffer,
} from './monitoring.activity';

let state: MonitoringState = { ...INITIAL_MONITORING_STATE };
let hydrated = false;

/**
 * In-flight transitions.
 *
 * Returned to a second caller rather than beginning a rival lifecycle: two
 * concurrent starts would each race to persist a session id, and two
 * concurrent stops would each try to settle the day.
 */
let startInFlight: Promise<MonitoringState> | null = null;
let stopInFlight: Promise<MonitoringState> | null = null;
let continuationInFlight: Promise<void> | null = null;

// Registered synchronously while the module loads, not when a session starts.
// An MV3 worker is woken BY this event; a listener added later, after an
// await, is not there when the waking event is dispatched — and the "active"
// that was lost that way left a period open for the rest of the session. The
// handler checks the session state itself.
chrome.idle?.onStateChanged?.addListener(onIdleStateChanged);

// ─── State plumbing ───────────────────────────────────────────────────────────

async function readState(): Promise<MonitoringState> {
  const stored = await chrome.storage.local.get([MONITORING_STORAGE_KEYS.STATE]);
  const persisted = stored[MONITORING_STORAGE_KEYS.STATE] as MonitoringState | undefined;
  return persisted
    ? { ...INITIAL_MONITORING_STATE, ...persisted }
    : { ...INITIAL_MONITORING_STATE };
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  state = await readState();
  hydrated = true;
}

async function persist(updates: Partial<MonitoringState>): Promise<void> {
  state = { ...state, ...updates };
  hydrated = true;
  await chrome.storage.local.set({ [MONITORING_STORAGE_KEYS.STATE]: state });
  chrome.runtime.sendMessage({ type: 'MONITORING_STATE_CHANGED', payload: state }).catch(() => {
    // No popup open; it re-reads state when next opened.
  });
}

export function getMonitoringState(): MonitoringState {
  return state;
}

/** Read-through accessor for callers that may run in a freshly-woken worker. */
export async function loadMonitoringState(): Promise<MonitoringState> {
  await hydrate();
  // No round trip to ask "is capture alive" any more. Capture lives in the
  // agent, and the only honest liveness signal is whether frames are still
  // arriving — which the persisted health already records, and the watchdog
  // already judges.
  return state;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

/**
 * Writes from the agent that are still in flight.
 *
 * The agent's messages arrive on a port callback, which cannot be awaited by
 * whoever is stopping the session. Without this, the stop could be queued while
 * the final interval was still being written, and that interval would then be
 * filed behind the stop that ends its session.
 */
const pendingActivityWrites = new Set<Promise<void>>();

function trackActivityWrite(run: () => Promise<void>): void {
  const write = run()
    .catch((err) => {
      console.warn('[Monitoring] failed to record a native interval:', err);
    })
    .finally(() => {
      pendingActivityWrites.delete(write);
    });
  pendingActivityWrites.add(write);
}

/** Wait for those writes, so a flush means "queued", not "about to be". */
async function settleActivityWrites(): Promise<void> {
  while (pendingActivityWrites.size > 0) {
    await Promise.all([...pendingActivityWrites]);
  }
}

export function configureMonitoringOffscreen(_bridge: {
  ensureDocument: () => Promise<void>;
  send: (type: string, payload?: unknown) => Promise<unknown>;
}): void {
  // Closed activity intervals go straight to the outbox, filed under whatever
  // session is current at the moment they close.
  configureActivitySink(async (activity) => {
    await hydrate();
    if (!state.sessionId || !state.project) {
      console.warn('[Monitoring] an activity interval closed with no session to file it under');
      return;
    }
    await enqueueActivity(state.sessionId, state.project, activity);
  });

  configureSync({
    onStatus: async (sync: SyncStatus) => {
      await hydrate();
      await persist({
        queuedSnapshots: sync.pendingSnapshots,
        failedSnapshots: sync.deadSnapshots,
        pendingSyncItems: sync.pendingActivities + sync.pendingEvents,
        syncBacklogSince:
          sync.oldestPendingAtMs == null ? null : new Date(sync.oldestPendingAtMs).toISOString(),
        uploadError: sync.lastError,
        offlineSince: sync.offlineSince,
      });
      if (isMonitoringSessionLive()) setMonitoringBadge();
    },
    onSnapshotStored: async (_sessionId, capturedAt) => {
      await hydrate();
      if (!isMonitoringSessionLive() && state.status !== 'stopping') return;
      // A backlog frame from hours ago lands after newer ones; "last
      // screenshot" must not move backwards when it does.
      const newer =
        !state.lastScreenshotAt || Date.parse(capturedAt) > Date.parse(state.lastScreenshotAt);
      await persist({
        screenshotCount: state.screenshotCount + 1,
        lastScreenshotAt: newer ? capturedAt : state.lastScreenshotAt,
      });
    },
    onSessionClosed: (sessionId) => {
      void (async () => {
        await hydrate();
        if (sessionId === state.sessionId) await continueAfterRemoteClose();
      })();
    },
  });

  configureNativeAgent({
    onActivity: (interval: NativeActivity) => {
      trackActivityWrite(async () => {
        await hydrate();
        // 'stopping' counts. The stop flips the status before flushing the
        // agent, and the agent emits an interval only when it *ends* — so the
        // interval closed by that flush, which for a session spent in one
        // application is the session's only interval, arrives while the status
        // reads 'stopping'. Rejecting it here dropped the whole session's
        // application time; sessions that happened to contain a focus change
        // kept their earlier intervals and lost only the last one.
        if (state.status !== 'monitoring' && state.status !== 'stopping') return;

        // The browser stopped being the frontmost application, so this
        // extension's page tracking must stop with it.
        //
        // It follows the active tab, and an active tab stays active while the
        // browser sits behind Slack or an editor. One report showed 8m43s on a
        // single page during a session where the browser was frontmost for
        // 3m36s — page time cannot exceed browser time, and did.
        //
        // Only on a real application switch: closing on every browser interval
        // would discard page time at each tab-title change instead, since
        // nothing reopens the interval until the next tab or focus event.
        if (interval.focusLeftApplication && interval.browserName) {
          await closeOpenActivity(new Date(interval.endedAt));
        }

        await recordNativeInterval(interval);
        await persist({
          lastActivityAt: interval.endedAt,
          currentActivityLabel: interval.applicationName,
        });
      });
    },

    // System-wide inactivity, from the agent's OS idle counter.
    //
    // This is why the agent owns inactivity whenever it is connected:
    // `chrome.idle` only signals a threshold crossing, so a 22-minute absence
    // would be recorded as the 5-minute threshold. The agent reports the real
    // start — when input actually stopped — and the real duration.
    onIdle: (event: NativeIdleEvent) => {
      void withInactivity(async () => {
        await hydrate();
        if (event.idle) {
          if (state.status !== 'monitoring') return;
          // Checked against the OS before it is believed — see agentIdleStarted.
          const bounds = await probeOsIdle();
          await applyInactivity(
            agentIdleStarted(
              inactivityTracker(),
              event.startedAt,
              bounds,
              state.inactivityThresholdSeconds,
            ),
            'agent idle',
          );
          return;
        }
        // An end is honoured in any state: an open period must always be
        // closable, whoever opened it and whatever the session is doing.
        await applyInactivity(
          idleEnded(inactivityTracker(), event.endedAt ?? new Date().toISOString()),
          'agent active',
        );
      });
    },

    // A captured frame goes straight into the durable outbox, then sync takes
    // it. Enqueue-before-upload is deliberate: the frame survives a worker
    // teardown, a network outage and a browser restart, whereas uploading
    // inline would lose it on any of the three.
    onScreenFrame: (frame) => {
      void (async () => {
        await hydrate();
        if (state.status !== 'monitoring' || !state.sessionId || !state.project) return;
        try {
          await enqueueSnapshot({
            clientSnapshotId: generateId(20),
            sessionId: state.sessionId,
            project: state.project,
            capturedAt: frame.capturedAt,
            blob: new Blob([frame.bytes as BlobPart], { type: frame.mimeType }),
            mimeType: frame.mimeType,
            fileSize: frame.bytes.length,
          });
        } catch (err) {
          console.warn('[Monitoring] could not queue a captured frame:', err);
          await persist({ capture: noteFrameFailed('The screenshot could not be stored.', false) });
          return;
        }
        await persist({ capture: noteFrameCaptured(frame.capturedAt) });
        void drainSync('live');
      })();
    },

    onCaptureError: (reason, permanent) => {
      void (async () => {
        await hydrate();
        if (state.status !== 'monitoring') return;
        await persist({ capture: noteFrameFailed(reason, permanent) });
        setMonitoringBadge();
      })();
    },

    onStateChange: (native: NativeAgentState) => {
      void (async () => {
        await hydrate();
        await persist({ native });
        setMonitoringBadge();
      })();
    },
  });
}

/**
 * Record a session event in the outbox and nudge delivery.
 *
 * Local state is updated by the caller whether or not the server can be
 * reached — getting the event there, in order, is the outbox's job.
 */
async function queueSessionEvent(
  kind: MonitoringEventKind,
  at: string,
  pauses?: MonitoringPauseInterval[],
): Promise<void> {
  if (!state.sessionId || !state.project) return;
  try {
    await enqueueEvent({ sessionId: state.sessionId, project: state.project, kind, at, pauses });
  } catch (err) {
    console.warn(`[Monitoring] could not save a ${kind} event:`, err);
    return;
  }
  void drainSync('live');
}

// ─── Inactivity ───────────────────────────────────────────────────────────────

/**
 * One inactivity decision at a time.
 *
 * Agent events, `chrome.idle` events, the reconcile and the lifecycle all read
 * the tracker, may await an OS probe, and then act. Interleaved, two of them
 * could each see nothing open and each open a period; serialized, the second
 * sees what the first did.
 */
let inactivityChain: Promise<unknown> = Promise.resolve();

function withInactivity<T>(run: () => Promise<T>): Promise<T | undefined> {
  const next = inactivityChain.then(run, run).catch((err) => {
    console.warn('[Monitoring] inactivity update failed:', err);
    return undefined;
  });
  inactivityChain = next;
  return next;
}

function inactivityTracker(): InactivityTracker {
  return {
    openSince: state.openInactivityStartedAt,
    pendingSince: state.pendingIdleSince,
    notBefore: state.inactivityNotBefore ?? state.startedAt,
  };
}

/** Queue what a decision says, and remember the tracker it leaves behind. */
async function applyInactivity(decision: InactivityDecision, context: string): Promise<void> {
  const before = inactivityTracker();
  if (decision.commands.length > 0 && (!state.sessionId || !state.project)) return;

  let lastClosedAt: string | null = null;
  for (const command of decision.commands) {
    await queueSessionEvent(
      command.kind === 'open' ? 'inactivity-start' : 'inactivity-end',
      command.at,
    );
    if (command.kind === 'close') lastClosedAt = command.at;
  }
  if (decision.commands.length > 0 || decision.reason) {
    console.log(
      `[Monitoring] inactivity (${context}): ${decision.reason ?? 'no change'}`,
      decision.commands,
    );
  }

  const after = decision.tracker;
  if (after.openSince === before.openSince && after.pendingSince === before.pendingSince) return;
  await persist({
    openInactivityStartedAt: after.openSince,
    pendingIdleSince: after.pendingSince,
    ...(lastClosedAt ? { lastActivityAt: lastClosedAt } : {}),
  });
}

/**
 * The OS's own idle counter, bracketed.
 *
 * `chrome.idle.queryState(n)` answers "was there input within n seconds" from
 * the same OS source the agent reads, with no dependency on the agent, the
 * port, or any event having been delivered. Null when it cannot be read.
 */
async function probeOsIdle(): Promise<IdleBounds | null> {
  if (!chrome.idle?.queryState) return null;
  const ladder = probeLadder(
    state.inactivityThresholdSeconds,
    INACTIVITY_POLICY.AUTO_STOP_AFTER_MS / 1000,
  );
  try {
    const probes = await Promise.all(
      ladder.map(async (intervalSeconds) => ({
        intervalSeconds,
        state: (await chrome.idle.queryState(intervalSeconds)) as OsIdleState,
      })),
    );
    return idleBoundsFromProbes(probes);
  } catch (err) {
    console.warn('[Monitoring] could not read the OS idle state:', err);
    return null;
  }
}

/**
 * The safety net: bring inactivity in line with the OS, then stop the session
 * if it has been inactive for the whole limit.
 *
 * Returns true when it stopped the session.
 */
async function reconcileAndMaybeAutoStop(): Promise<boolean> {
  const stopAt = await withInactivity(async () => {
    await hydrate();
    if (state.status !== 'monitoring') return null;
    const bounds = await probeOsIdle();
    const now = Date.now();
    await applyInactivity(
      reconcileInactivity(inactivityTracker(), bounds, now, state.inactivityThresholdSeconds),
      'reconcile',
    );
    return autoStopAt(inactivityTracker(), bounds, now, state.inactivityThresholdSeconds);
  });
  if (stopAt == null) return false;

  const minutes = Math.round(INACTIVITY_POLICY.AUTO_STOP_AFTER_MS / 60_000);
  console.warn(`[Monitoring] inactive for ${minutes} minutes — stopping the session`);
  await stopMonitoringSession({
    at: new Date(stopAt),
    notice: `Monitoring stopped automatically after ${minutes} minutes of inactivity. Start it again when you are back.`,
  });
  return true;
}

// ─── Liveness ─────────────────────────────────────────────────────────────────

/**
 * This machine's own record of when it was running, kept per session.
 *
 * The server can only see heartbeats. When it expires a session after an
 * outage, this is what says how long monitoring really went on — through the
 * outage, which was monitored, but not through a sleep, which was not.
 */
async function readLiveness(): Promise<LivenessSegment[]> {
  const stored = await chrome.storage.local.get([MONITORING_STORAGE_KEYS.LIVENESS]);
  return (stored[MONITORING_STORAGE_KEYS.LIVENESS] as LivenessSegment[] | undefined) ?? [];
}

async function noteAlive(atMs = Date.now()): Promise<LivenessSegment[]> {
  const segments = extendLiveness(await readLiveness(), atMs);
  await chrome.storage.local.set({ [MONITORING_STORAGE_KEYS.LIVENESS]: segments });
  return segments;
}

/**
 * End the session if this machine was not running it for the auto-stop limit.
 *
 * Shut down, asleep, Chrome closed or crashed, extension killed — the liveness
 * log stops in every case, and `awayStopAt` decides. The stop is dated to the
 * last moment the machine was alive; the server, which will usually have
 * expired the session by then, re-settles it to exactly that.
 */
async function endIfAwayTooLong(): Promise<boolean> {
  if (state.status !== 'monitoring' && state.status !== 'paused') return false;
  const segments = await readLiveness();
  const lastAlive = segments.length > 0 ? segments[segments.length - 1].to : null;
  const stopAt = awayStopAt(lastAlive, Date.now());
  if (stopAt == null) return false;

  const since = new Date(stopAt).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  console.warn(`[Monitoring] not running since ${since} — ending the session there`);
  await stopMonitoringSession({
    at: new Date(stopAt),
    notice: `Monitoring stopped because this computer was off, asleep or not running Chrome from ${since}. Start it again when you are ready.`,
  });
  return true;
}

/** The end this client can vouch for, for a stop issued at `atMs`. */
async function settledSessionEnd(atMs: number): Promise<number> {
  const segments = await noteAlive(atMs);
  const contactMs = state.lastServerContactAt ? Date.parse(state.lastServerContactAt) : Number.NaN;
  return settledEndMs(segments, Number.isFinite(contactMs) ? contactMs : null, atMs);
}

function pauseIntervals(untilIso: string): MonitoringPauseInterval[] {
  return state.pauseHistory.map((pause) => ({
    startedAt: pause.from,
    endedAt: pause.to ?? untilIso,
  }));
}

// ─── Start ────────────────────────────────────────────────────────────────────

/**
 * Begin a session.
 *
 * The `clientSessionId` is persisted before the first request so every retry
 * reuses it and the idempotent `start` endpoint returns the same session rather
 * than opening a second one.
 */
export function startMonitoringSession(options: {
  intervalSeconds: MonitoringInterval;
  project?: string;
}): Promise<MonitoringState> {
  if (startInFlight) return startInFlight;
  startInFlight = runStart(options).finally(() => {
    startInFlight = null;
  });
  return startInFlight;
}

async function runStart(options: {
  intervalSeconds: MonitoringInterval;
  project?: string;
}): Promise<MonitoringState> {
  // A Start right after a Stop waits for it rather than refusing: the stop is
  // what lets the server open the next session at all.
  if (stopInFlight) await stopInFlight.catch(() => undefined);
  await hydrate();

  if (state.status === 'monitoring' || state.status === 'paused') return state;
  if (state.status === 'stopping') {
    await persist({ error: 'The previous session is still stopping — try again in a moment.' });
    return state;
  }

  // The caller's explicit choice, then the remembered one, then a default
  // resolved here.
  //
  // The last step matters because starting monitoring does not always go
  // through the popup — a keyboard shortcut or a resumed session reaches this
  // with no project at all. Without it, a user assigned to exactly one project
  // was told to "select a project" with nothing to select between.
  const project =
    options.project ?? (await getMonitoringProject()) ?? (await defaultProjectOrNull());

  if (!project) {
    await persist({
      status: 'idle',
      error: 'No project is available for monitoring. Ask an administrator to assign you to one.',
    });
    return state;
  }
  // Monitoring's own key — see MONITORING_STORAGE_KEYS.PROJECT for why this is
  // not the shared `st_auth_project`.
  await setMonitoringProject(project);

  const clientSessionId = state.clientSessionId ?? generateId(24);
  await persist({
    status: 'starting',
    clientSessionId,
    project,
    intervalSeconds: options.intervalSeconds,
    capture: { ...getCaptureHealth(), status: 'requesting', error: null },
    error: null,
    stopNotice: null,
  });

  // ── 1. Backend session ───────────────────────────────────────────────────
  //
  // Only a session id the server returned may put this client in 'monitoring'.
  // The old handling of MONITORING_ALREADY_ACTIVE set 'monitoring' with NO
  // session id — the popup said "Monitoring Active" while every frame and
  // interval was dropped for having nowhere to go, and the server showed the
  // previous session running on, empty. That refusal is now resolved instead.
  try {
    // Our own earlier sessions are settled before a new one opens: a stop still
    // queued from a moment ago, or from while offline, lands as the proper stop
    // it was — not as an expiry the server works out for itself.
    for (const earlier of await sessionsAwaitingStop()) await deliverSessionEvents(earlier);

    const response = await startResolvingConflict(
      project,
      clientSessionId,
      options.intervalSeconds,
    );
    const now = Date.now();
    await persist({
      status: 'monitoring',
      sessionId: response.session.id,
      dailyReportId: response.dailyReport.id,
      // The server's threshold, not ours. It drops any period shorter than its
      // own, so disagreeing here loses every inactive period silently.
      inactivityThresholdSeconds:
        response.inactivityThresholdSeconds || INACTIVITY_THRESHOLD_SECONDS,
      startedAt: response.session.startedAt,
      pausedMs: 0,
      pausedAt: null,
      pauseHistory: [],
      openInactivityStartedAt: null,
      pendingIdleSince: null,
      inactivityNotBefore: response.session.startedAt,
      lastServerContactAt: new Date(now).toISOString(),
      screenshotCount: response.session.screenshotCount ?? 0,
      lastScreenshotAt: null,
      error: null,
    });
    // A fresh session starts a fresh liveness log.
    await chrome.storage.local.set({
      [MONITORING_STORAGE_KEYS.LIVENESS]: extendLiveness([], now),
    });
    await noteServerReachable();
  } catch (err) {
    await noteServerUnreachable(err);
    const message =
      err instanceof MonitoringApiError && err.code === 'MONITORING_ALREADY_ACTIVE'
        ? 'A previous monitoring session is still open on the server and could not be closed. Wait a minute and start again.'
        : err instanceof MonitoringApiError && err.status === 0
          ? 'Cannot reach the BestQ server. Check your internet connection and try again.'
          : err instanceof Error
            ? err.message
            : 'Could not start monitoring';
    await persist({ status: 'idle', error: message });
    return state;
  }

  // ── 2. Agent, capture, activity, heartbeat ───────────────────────────────
  //
  // The agent goes FIRST, and capture waits for it. Capture is the agent's job
  // now, so starting capture before the port is open reported "the agent is
  // not running" on a machine where it was running perfectly — the popup said
  // that while showing "Activity agent: Connected" two lines below, because
  // the agent connected a moment later.
  //
  // Bound to the session id so intervals it reports can be attributed, and so
  // an agent restart can re-bind itself without the extension intervening.
  startNativeMonitoring(state.sessionId!, state.inactivityThresholdSeconds, state.intervalSeconds);

  // Bounded: a missing agent must fail the capture cleanly rather than hold
  // the start open. Activity, time and inactivity are unaffected either way.
  await waitForNativeAgent(6000);

  await beginCapture();

  await initializeCurrentActivity({ nativeTracking: isNativeAgentTracking() });
  startIdleDetection();
  await armAlarm();

  await persist({
    currentActivityLabel: await currentActivityLabel(),
    native: getNativeAgentState(),
  });
  setMonitoringBadge();
  return state;
}

/**
 * Start a session, settling whatever the server says is still live first.
 *
 * MONITORING_ALREADY_ACTIVE almost always means our own previous session: its
 * stop is still in the outbox — the Stop was pressed moments ago, or offline —
 * or the browser crashed before it could stop. Either way this client is the
 * one to settle it: our own queued stops are delivered in order, and a live
 * session we hold no stop for (another crashed browser of this user) is stopped
 * at its last heartbeat, so it is not credited time nobody was monitored. The
 * start is then tried once more. If a session on another device was genuinely
 * running, it notices at its next heartbeat and stops there — the most recent
 * Start wins, rather than leaving two clients writing one day.
 */
async function startResolvingConflict(
  project: string,
  clientSessionId: string,
  intervalSeconds: MonitoringInterval,
): Promise<StartMonitoringResponse> {
  try {
    return await apiStart(project, clientSessionId, intervalSeconds, new Date().toISOString());
  } catch (err) {
    if (!(err instanceof MonitoringApiError) || err.code !== 'MONITORING_ALREADY_ACTIVE') throw err;

    const liveId = parseLiveSessionId(err.message);
    console.warn(
      `[Monitoring] start refused: session ${liveId ?? '(unnamed)'} is still live — settling it`,
    );

    const ours = await sessionsAwaitingStop();
    for (const sessionId of ours) await deliverSessionEvents(sessionId);

    if (liveId && !ours.includes(liveId)) {
      let endedAt = new Date().toISOString();
      try {
        const live = await fetchMonitoringSession(project, liveId);
        if (live.lastHeartbeatAt) endedAt = live.lastHeartbeatAt;
      } catch {
        /* unreadable — settle it now rather than not at all */
      }
      await apiStop(project, liveId, endedAt);
    }

    return apiStart(project, clientSessionId, intervalSeconds, new Date().toISOString());
  }
}

async function beginCapture(): Promise<void> {
  if (!state.sessionId || !state.project) return;

  // The agent's own report of what it can do, not an assumption. Monitoring
  // means the entire screen, so if the agent cannot deliver that the session
  // says so — there is no browser fallback left, by design: the fallback was
  // the share picker, which could be aimed at a single tab.
  const agent = getNativeAgentState();
  const result = startCapture(
    {
      connected: isNativeAgentTracking(),
      screenCapture: agent.capabilities?.screenCapture === true,
      permissionMissing: agent.permissions?.screenRecording === false,
      unsupported: agent.status === 'unsupported-platform',
    },
    state.intervalSeconds,
  );

  // Delivery runs here in the worker, and it runs even when capture failed to
  // start: a previous session may have left data queued, and that is still
  // owed to the server.
  startSyncSweep();

  await persist({
    capture: result.health,
    // Capture failing does not end the session — time, activity and inactivity
    // are still recorded — but the user must be told plainly, because a session
    // with no screenshots is not what they asked for.
    error: result.started ? null : (result.health.error ?? 'Screen capture could not be started.'),
  });
}

/**
 * Re-acquire the screen after capture stopped.
 *
 * The session continues untouched, so nothing already recorded is affected.
 */
export async function reconnectMonitoringCapture(): Promise<MonitoringState> {
  await hydrate();
  if (state.status !== 'monitoring' || !state.sessionId) return state;

  await persist({ capture: { ...state.capture, status: 'requesting', error: null } });
  await beginCapture();
  setMonitoringBadge();
  return state;
}

/**
 * A project to monitor into when nobody named one.
 *
 * Returns null rather than throwing: a failure to reach the projects API must
 * produce the "no project available" message, not an unhandled rejection that
 * leaves the session half-started.
 */
async function defaultProjectOrNull(): Promise<string | null> {
  try {
    return await resolveDefaultProject(await getAssignedProjects());
  } catch (err) {
    console.warn('[Monitoring] could not resolve a default project:', err);
    return null;
  }
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

/**
 * Stop, with everything the session produced queued ahead of the stop.
 *
 * The order is the point: the open activity and inactive period are closed at
 * the true stop time and queued, and only then is the stop queued behind them.
 * Delivery gets a bounded chance to finish while the popup waits; whatever the
 * server cannot take right now stays in the outbox and keeps uploading after
 * the session is gone locally. Stopping during an outage loses nothing.
 */
export function stopMonitoringSession(
  options: { at?: Date; notice?: string } = {},
): Promise<MonitoringState> {
  if (stopInFlight) return stopInFlight;
  stopInFlight = runStop(options).finally(() => {
    stopInFlight = null;
  });
  return stopInFlight;
}

async function runStop(options: { at?: Date; notice?: string }): Promise<MonitoringState> {
  // A Stop pressed while a Start is still resolving would otherwise tear down
  // first and then be undone by the start finishing after it.
  if (startInFlight) await startInFlight.catch(() => undefined);
  await hydrate();
  if (state.status === 'idle') return state;

  const { project, sessionId } = state;
  // Flip first: this stops new activity events and new captures from being
  // treated as part of a live session.
  await persist({ status: 'stopping' });

  const stoppedAt = options.at ?? new Date();

  // Everything up to the teardown is best effort. Whatever fails, the teardown
  // below still runs and the state still ends 'idle' — a stop that threw
  // half-way used to leave the popup showing a session that was neither
  // running nor able to be started again.
  try {
    // 1. Close what is open, at the real stop time.
    //    Awaited: the agent emits an interval only when it ends, so for a
    //    session spent in a single application this flush produces the
    //    session's only activity row, and it must be queued before the stop.
    await flushNativeAgent();
    await settleActivityWrites();
    await closeOpenActivity(stoppedAt);
    await closeOpenInactivity(stoppedAt);

    if (project && sessionId) {
      // 2. The stop, at the end this client can vouch for. Online that is
      //    simply the stop time; if the server expired the session during an
      //    outage, it is what the server re-settles the session to.
      const endedAt = new Date(await settledSessionEnd(stoppedAt.getTime())).toISOString();
      await enqueueEvent({
        sessionId,
        project,
        kind: 'stop',
        at: endedAt,
        pauses: pauseIntervals(endedAt),
      });

      // 3. A bounded chance for the live data to land first, then the stop is
      //    delivered directly rather than left to the outbox's pacing: until
      //    the server has it, the session stays live there, and a Start in the
      //    meantime is refused. Offline, it stays queued and goes later.
      await flushSessionSync(sessionId, 15_000);
      await deliverSessionEvents(sessionId);
    }
  } catch (err) {
    console.warn('[Monitoring] stop did not complete cleanly; finishing locally:', err);
  }

  // 4. Only now may capture go.
  try {
    stopSyncSweep();
    stopCapture();
    stopNativeMonitoring();
    stopIdleDetection();
    await chrome.alarms.clear(MONITORING_ALARMS.TICK);
    await clearActivityState();
    await chrome.storage.local.remove([MONITORING_STORAGE_KEYS.LIVENESS]);
    resetCaptureHealth();
  } catch (err) {
    console.warn('[Monitoring] teardown was incomplete:', err);
  }

  await persist({
    ...INITIAL_MONITORING_STATE,
    // Sync status outlives the session: what is still uploading, and anything
    // that genuinely could not be, must stay visible after it has stopped.
    queuedSnapshots: state.queuedSnapshots,
    failedSnapshots: state.failedSnapshots,
    pendingSyncItems: state.pendingSyncItems,
    syncBacklogSince: state.syncBacklogSince,
    uploadError: state.uploadError,
    offlineSince: state.offlineSince,
    stopNotice: options.notice ?? null,
  });
  clearMonitoringBadge();
  void drainSync('sweep');
  return state;
}

// ─── Pause / resume ───────────────────────────────────────────────────────────

/**
 * Pause.
 *
 * Paused time is subtracted from monitored duration server-side and is NOT
 * inactivity — the user chose to suspend monitoring, which is a different fact
 * from being away from the keyboard. Capture and activity both stop, so no
 * screenshot is taken and no time is attributed to a stretch the user excluded.
 */
export async function pauseMonitoringSession(): Promise<MonitoringState> {
  await hydrate();
  if (state.status !== 'monitoring' || !state.project || !state.sessionId) return state;

  const at = new Date();
  // An inactive stretch cannot span a pause: it is monitored time, and paused
  // time is not monitored at all.
  await closeOpenInactivity(at);
  await closeOpenActivity(at);
  pauseNativeAgent();
  await queueSessionEvent('pause', at.toISOString());

  stopIdleDetection();
  await persist({
    status: 'paused',
    pausedAt: at.toISOString(),
    pauseHistory: [...state.pauseHistory, { from: at.toISOString(), to: null }],
    capture: { ...getCaptureHealth(), status: 'idle' },
    currentActivityLabel: null,
  });
  setMonitoringBadge();
  return state;
}

/** Resume. */
export async function resumeMonitoringSession(): Promise<MonitoringState> {
  await hydrate();
  if (state.status !== 'paused' || !state.project || !state.sessionId) return state;

  const at = new Date();
  const atIso = at.toISOString();
  await queueSessionEvent('resume', atIso);

  const pausedMs =
    state.pausedMs + (state.pausedAt ? at.getTime() - new Date(state.pausedAt).getTime() : 0);
  await persist({
    status: 'monitoring',
    pausedAt: null,
    pausedMs,
    inactivityNotBefore: atIso,
    pendingIdleSince: null,
    pauseHistory: state.pauseHistory.map((pause, index) =>
      index === state.pauseHistory.length - 1 && pause.to === null
        ? { ...pause, to: atIso }
        : pause,
    ),
  });

  await beginCapture();

  resumeNativeAgent();
  await initializeCurrentActivity({ nativeTracking: isNativeAgentTracking() });
  startIdleDetection();
  await armAlarm();
  await persist({ currentActivityLabel: await currentActivityLabel() });
  setMonitoringBadge();
  return state;
}

// ─── A session the server closed underneath us ────────────────────────────────

/**
 * Keep monitoring after the server closed the live session.
 *
 * The server closes a live session for reasons that are not the user stopping:
 * it expired it after hearing nothing for too long — a network outage, a
 * backend that was down, a laptop asleep — or it split it at midnight. Stopping
 * locally, which is what used to happen, silently ended a session the person
 * believed was running and orphaned everything captured while the server could
 * not hear it.
 *
 * Instead:
 *  1. Whatever is open is closed and filed under the old session.
 *  2. The old session gets a stop at the end this machine can vouch for. The
 *     server re-settles an expired session to that end, which widens it over
 *     the outage so everything captured then lands in it; for a midnight split
 *     it is a no-op.
 *  3. Monitoring continues in the server session that covers the present: the
 *     midnight continuation if there is one — found by re-using the client
 *     session id, which the rollover carries over — otherwise a new session
 *     starting where this run of liveness began.
 *  4. Never-sent items from after that start move to the new session. Anything
 *     else the old session refuses follows by timestamp as sync meets it.
 */
function continueAfterRemoteClose(): Promise<void> {
  if (continuationInFlight) return continuationInFlight;
  continuationInFlight = runContinuation()
    .catch((err) => {
      console.warn('[Monitoring] could not continue after the session closed:', err);
    })
    .finally(() => {
      continuationInFlight = null;
    });
  return continuationInFlight;
}

async function runContinuation(): Promise<void> {
  await hydrate();
  const { project, sessionId: closedId } = state;
  if ((state.status !== 'monitoring' && state.status !== 'paused') || !project || !closedId) {
    return;
  }
  // Woken after the auto-stop limit — the first frame to arrive after a long
  // sleep can bring us here before the minute tick does. That ends the session
  // where it stopped; it does not continue it.
  if (await endIfAwayTooLong()) return;

  // An administrator's stop is honoured, not recovered from. Expiry, a midnight
  // split and a takeover all close the session too, and those this client does
  // recover from — so the reason is asked for rather than assumed. Unreadable
  // (offline) means the continuation below cannot proceed either, and the next
  // tick asks again.
  const closed = await fetchMonitoringSession(project, closedId).catch(() => null);
  if (closed?.endReason === 'ADMIN') {
    console.warn(`[Monitoring] session ${closedId} was stopped by an administrator`);
    await stopMonitoringSession({
      notice:
        'Your administrator stopped this monitoring session. Start it again when you are asked to.',
    });
    return;
  }

  const wasPaused = state.status === 'paused';
  const at = new Date();

  // 1. Close what is open, into the old session.
  if (!wasPaused) {
    await flushNativeAgent();
    await settleActivityWrites();
    await closeOpenActivity(at);
    await closeOpenInactivity(at);
  }

  // 2. Re-settle the old session. A retry after a failed step 3 must not queue
  //    a second stop.
  const endMs = await settledSessionEnd(at.getTime());
  const startMs = Math.max(endMs, currentRunStartMs(await readLiveness(), at.getTime()));
  const alreadyQueued = (await listPendingEvents()).some(
    (event) => event.sessionId === closedId && event.kind === 'stop',
  );
  if (!alreadyQueued) {
    const endIso = new Date(endMs).toISOString();
    await enqueueEvent({
      sessionId: closedId,
      project,
      kind: 'stop',
      at: endIso,
      pauses: pauseIntervals(endIso),
    });
  }
  await updateSyncSession(closedId, { closedRemotely: true });
  void drainSync('live');

  // 3. The session that covers now.
  let next: { response: StartMonitoringResponse; clientSessionId: string };
  try {
    next = await startContinuation(project, closedId, new Date(startMs).toISOString());
  } catch (err) {
    if (err instanceof MonitoringApiError && err.code === 'MONITORING_ALREADY_ACTIVE') {
      // Another browser or device holds a live session for this user and
      // project, and two cannot run at once. This one ends; what it captured is
      // safe in the outbox either way.
      console.warn('[Monitoring] another client holds the live session — stopping here');
      await stopMonitoringSession();
      await persist({
        error:
          'Monitoring was started from another browser or device, so it stopped here. Everything captured here is saved and will upload.',
      });
      return;
    }
    // Most likely still offline. Monitoring carries on locally under the old
    // session and the next tick tries again.
    await noteServerUnreachable(err);
    console.warn('[Monitoring] could not open the continuation session yet:', err);
    return;
  }

  const { response, clientSessionId } = next;
  const nextId = response.session.id;
  const parsedStart = Date.parse(response.session.startedAt);
  const nextStartedMs = Number.isFinite(parsedStart) ? parsedStart : startMs;

  // 4. Point the old session's data at its successor.
  await updateSyncSession(closedId, {
    closedRemotely: true,
    successorId: nextId,
    successorStartedAtMs: nextStartedMs,
  });
  const moved = await retagSession(closedId, nextId, nextStartedMs);
  await unparkSession(closedId);

  await persist({
    sessionId: nextId,
    clientSessionId,
    dailyReportId: response.dailyReport.id,
    inactivityThresholdSeconds:
      response.inactivityThresholdSeconds || state.inactivityThresholdSeconds,
    lastServerContactAt: new Date().toISOString(),
    openInactivityStartedAt: null,
    pendingIdleSince: null,
    inactivityNotBefore: response.session.startedAt,
    error: null,
  });
  await noteServerReachable();
  console.log(
    `[Monitoring] session ${closedId} was closed by the server; continuing in ${nextId} (${moved} queued item(s) moved)`,
  );

  // Carry on exactly where monitoring was.
  startNativeMonitoring(nextId, state.inactivityThresholdSeconds, state.intervalSeconds);
  if (wasPaused) {
    pauseNativeAgent();
    await queueSessionEvent('pause', response.session.startedAt);
  } else {
    await initializeCurrentActivity({ nativeTracking: isNativeAgentTracking() });
  }

  await persist({
    currentActivityLabel: await currentActivityLabel(),
    native: getNativeAgentState(),
  });
  setMonitoringBadge();
  void drainSync('live');
  // Still away from the keyboard, the idle stretch continues in the new
  // session. Decided by the OS, not assumed from before the switch.
  await reconcileAndMaybeAutoStop();
}

async function startContinuation(
  project: string,
  closedId: string,
  startedAt: string,
): Promise<{ response: StartMonitoringResponse; clientSessionId: string }> {
  // The same client id first: a midnight rollover carries it onto the next
  // day's session, and `start` hands that session back instead of creating one.
  if (state.clientSessionId) {
    const same = await apiStart(project, state.clientSessionId, state.intervalSeconds, startedAt);
    const live = same.session.status === 'ACTIVE' || same.session.status === 'PAUSED';
    if (same.session.id !== closedId && live) {
      return { response: same, clientSessionId: state.clientSessionId };
    }
  }
  // The same id resolves to the closed session itself, so a new one is needed.
  const fresh = generateId(24);
  return {
    response: await apiStart(project, fresh, state.intervalSeconds, startedAt),
    clientSessionId: fresh,
  };
}

// ─── Alarm upkeep ─────────────────────────────────────────────────────────────

async function armAlarm(): Promise<void> {
  await chrome.alarms.create(MONITORING_ALARMS.TICK, { periodInMinutes: 1 });
}

/**
 * Heartbeat, activity batch, and the capture watchdog.
 *
 * Runs in whatever worker instance the alarm woke, so it hydrates first.
 */
export async function handleMonitoringAlarm(): Promise<void> {
  await hydrate();
  if (state.status !== 'monitoring' && state.status !== 'paused') {
    await chrome.alarms.clear(MONITORING_ALARMS.TICK);
    return;
  }
  const { project, sessionId } = state;
  if (!project || !sessionId) return;

  // A machine that was off, asleep or not running Chrome for the whole limit:
  // the session ends where it stopped being monitored, not now.
  if (await endIfAwayTooLong()) return;

  // Proof of life, recorded locally before anything can fail.
  await noteAlive();

  // Inactivity checked against the OS before the heartbeat reports it — and
  // an hour of it ends the session here.
  if (await reconcileAndMaybeAutoStop()) return;

  // A paused session still heartbeats: the client IS alive, and letting it
  // expire during a legitimate pause would truncate the day. The heartbeat is
  // also sync's probe — it is what notices the server coming back.
  try {
    await sendHeartbeat(project, sessionId, {
      clientTime: new Date().toISOString(),
      lastActivityAt: state.lastActivityAt ?? undefined,
      lastSnapshotAt: state.lastScreenshotAt ?? undefined,
      idle: state.status === 'monitoring' && Boolean(state.openInactivityStartedAt),
    });
    await noteServerReachable();
    await persist({ lastServerContactAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof MonitoringApiError && err.code === 'MONITORING_SESSION_NOT_ACTIVE') {
      await noteServerReachable();
      await continueAfterRemoteClose();
    } else {
      await noteServerUnreachable(err);
    }
  }

  // Activity is batched per minute, and this tick is the batch.
  await drainSync('tick');

  if (state.status === 'monitoring') {
    await runCaptureWatchdog();
    // A port can stay nominally open while the agent process is wedged. The
    // heartbeat is the only evidence it is alive.
    recoverNativeAgentIfStale();
  }

  await persist({
    currentActivityLabel: await currentActivityLabel(),
    native: getNativeAgentState(),
  });
  setMonitoringBadge();
}

/** The outbox alarm. Runs with or without a live session. */
export async function handleMonitoringSyncAlarm(): Promise<void> {
  await hydrate();
  await handleSyncAlarm();
}

/**
 * Is capture genuinely working?
 *
 * Judged from frames actually arriving. The agent reports a failure it can see;
 * a stall it cannot see — everything claims fine, no frame in two intervals —
 * is caught by the age of the last frame.
 */
async function runCaptureWatchdog(): Promise<void> {
  const health = getCaptureHealth();

  if (health.status === 'reconnect' || health.status === 'failed') {
    await persist({
      capture: health,
      error: 'Screen capture disconnected — no new screenshots are being captured.',
    });
    return;
  }

  if (isCaptureStale(state.intervalSeconds)) {
    await persist({
      capture: {
        ...health,
        status: 'reconnect',
        error: 'No screenshot has been captured recently.',
      },
      error: 'Screen capture appears stalled — no new screenshots are being captured.',
    });
    return;
  }

  await persist({ capture: health, error: null });
}

// ─── Inactivity ───────────────────────────────────────────────────────────────

/**
 * OS-level idleness, via `chrome.idle`.
 *
 * The `idle` event fires when the detection interval has elapsed with no
 * keyboard or pointer input anywhere on the machine. It opens a period only
 * while the agent is not measuring idleness itself — the agent knows when input
 * actually stopped, `chrome.idle` only that the threshold passed. "active",
 * though, closes an open period whoever opened it: ignoring it because the agent
 * "owned" detection is how a period the agent never saw stayed open for hours.
 */
function onIdleStateChanged(newState: chrome.idle.IdleState): void {
  void withInactivity(async () => {
    await hydrate();
    if (state.status !== 'monitoring') return;
    await applyInactivity(
      browserIdleChanged(
        inactivityTracker(),
        newState as OsIdleState,
        Date.now(),
        nativeOwnsIdleDetection(),
      ),
      `chrome.idle ${newState}`,
    );
  });
}

/** Close any open period at `at` — for stop, pause and the session switch. */
async function closeOpenInactivity(at: Date): Promise<void> {
  // A stretch that turns out to be under the threshold is discarded by the
  // server, which is why nothing is filtered here.
  await withInactivity(async () => {
    await hydrate();
    await applyInactivity(idleEnded(inactivityTracker(), at.toISOString()), 'lifecycle');
  });
}

function startIdleDetection(): void {
  // chrome.idle enforces a 15s floor. The listener itself is registered once,
  // at module load; this only aligns the detection interval with the server's
  // threshold.
  try {
    chrome.idle.setDetectionInterval(Math.max(15, state.inactivityThresholdSeconds));
  } catch {
    /* keeps its previous interval */
  }
}

function stopIdleDetection(): void {
  // Nothing to remove: the handler ignores events outside a running session.
}

// ─── Activity entry points ────────────────────────────────────────────────────

/**
 * The single place browser activity enters monitoring.
 *
 * Called by the consolidated listeners in `background/index.ts`. Ignored unless
 * a session is actively monitoring, so a paused or stopping session cannot
 * accumulate activity it will never report.
 */
export async function noteActivePage(tab: chrome.tabs.Tab | undefined): Promise<void> {
  await hydrate();
  if (state.status !== 'monitoring') return;

  await noteActivePageInternal(tab, {
    nativeTracking: isNativeAgentTracking(),
    // A browser event fired, so as far as the browser can tell it is in front.
    browserInForeground: true,
  });
  await persist({
    lastActivityAt: new Date().toISOString(),
    currentActivityLabel: await currentActivityLabel(),
  });
}

/** Chrome lost OS focus. Close the page interval — the user is elsewhere. */
export async function noteBrowserBlurred(): Promise<void> {
  await hydrate();
  if (state.status !== 'monitoring') return;
  // Only meaningful without the agent. With it present the agent is already
  // reporting whatever took focus, and closing here too would leave a hole
  // between the two records.
  if (isNativeAgentTracking()) return;
  await closeOpenActivity(new Date());
  await persist({ currentActivityLabel: null });
}

// ─── Offscreen callbacks ──────────────────────────────────────────────────────

export async function handleMonitoringOffscreenMessage(
  type: string,
  payload: unknown,
): Promise<void> {
  await hydrate();

  switch (type) {
    case 'OFFSCREEN_MONITORING_HEALTH': {
      const { health } = (payload ?? {}) as { health?: CaptureHealth };
      if (health) {
        setCaptureHealth(health);
        await persist({ capture: health });
        setMonitoringBadge();
      }
      return;
    }

    case 'OFFSCREEN_MONITORING_SNAPSHOT_STORED': {
      const { capturedAt } = (payload ?? {}) as { capturedAt?: string };
      await persist({
        screenshotCount: state.screenshotCount + 1,
        lastScreenshotAt: capturedAt ?? new Date().toISOString(),
      });
      return;
    }

    case 'OFFSCREEN_MONITORING_SNAPSHOT_ENQUEUED': {
      // A frame just landed in the outbox. Delivery is the worker's job.
      void drainSync('live');
      return;
    }

    case 'OFFSCREEN_MONITORING_QUEUE': {
      const stats = (payload ?? {}) as {
        pending?: number;
        failed?: number;
        lastError?: string | null;
      };
      await persist({
        queuedSnapshots: stats.pending ?? 0,
        failedSnapshots: stats.failed ?? 0,
        uploadError: stats.lastError ?? null,
      });
      return;
    }

    case 'OFFSCREEN_MONITORING_CAPTURE_LOST': {
      const { reason } = (payload ?? {}) as { reason?: string };
      // The session stays alive: time, activity and inactivity are still being
      // recorded and everything already captured is safe. What is lost is the
      // ability to take NEW screenshots.
      await persist({
        capture: {
          ...getCaptureHealth(),
          status: 'reconnect',
          trackLive: false,
          error: reason ?? 'Screen sharing stopped.',
        },
        error: 'Screen capture disconnected — no new screenshots are being captured.',
      });
      setMonitoringBadge();
      return;
    }

    case 'OFFSCREEN_MONITORING_CAPTURE_ENDED': {
      // The session itself is gone server-side; there is nothing to capture into.
      await stopMonitoringSession();
      return;
    }

    default:
      return;
  }
}

// ─── Restore after a worker restart ───────────────────────────────────────────

/**
 * Re-establish what a live session needs in a freshly-woken worker.
 *
 * Listeners, alarms and the native port do not survive a teardown, so they are
 * re-created rather than assumed. Capture health lives in memory, so the
 * persisted copy stands in for it until the next frame arrives.
 *
 * Delivery resumes on every worker start whatever the session state: data
 * saved during an outage is owed to the server even if its session stopped long
 * ago, or the browser was restarted since.
 */
export async function restoreMonitoringSession(): Promise<void> {
  state = await readState();
  hydrated = true;

  // Rows an older build buffered in chrome.storage belong to the session that
  // was live when they were written, so they can only be moved while it is.
  if (state.sessionId && state.project) {
    try {
      const legacy = await takeLegacyActivityBuffer();
      for (const row of legacy) await enqueueActivity(state.sessionId, state.project, row);
      if (legacy.length > 0) {
        console.log(`[Monitoring] moved ${legacy.length} buffered activity row(s) into the outbox`);
      }
    } catch (err) {
      console.warn('[Monitoring] could not move buffered activity into the outbox:', err);
    }
  }

  void drainSync('sweep');

  // A worker torn down mid-transition must not leave the session stuck there:
  // 'stopping' used to refuse every later Start with "still stopping", and a
  // 'starting' or session-less 'monitoring' showed a session that captured
  // nothing.
  if (state.status === 'stopping') {
    void stopMonitoringSession();
    return;
  }
  if (state.status === 'starting' && !startInFlight) {
    // The client session id is kept, so starting again returns the same server
    // session if the interrupted start had created one.
    await persist({ status: 'idle', error: 'Monitoring did not finish starting. Start it again.' });
    return;
  }
  if ((state.status === 'monitoring' || state.status === 'paused') && !state.sessionId) {
    await persist({
      ...INITIAL_MONITORING_STATE,
      error: 'Monitoring was not connected to a server session. Start it again.',
    });
    clearMonitoringBadge();
    return;
  }

  if (state.status !== 'monitoring' && state.status !== 'paused') return;

  // Chrome or the whole machine was restarted: an absence as long as the
  // auto-stop limit ends the session where it stopped instead of resuming it.
  if (await endIfAwayTooLong()) return;

  await armAlarm();
  startSyncSweep();
  setCaptureHealth(state.capture);
  if (state.status === 'monitoring') {
    startIdleDetection();
    // Re-open the port and re-bind the session: the port does not survive a
    // worker teardown, but the agent process and its session binding do.
    if (state.sessionId) {
      startNativeMonitoring(
        state.sessionId,
        state.inactivityThresholdSeconds,
        state.intervalSeconds,
      );
    } else {
      connectNativeAgent();
    }
    await persist({ native: getNativeAgentState() });
  }
  setMonitoringBadge();
}

/**
 * Is a session live?
 *
 * Used by the offscreen-document owner check: recording finishing must not
 * close a document while monitoring is running.
 */
export function isMonitoringSessionLive(): boolean {
  return state.status === 'monitoring' || state.status === 'paused' || state.status === 'starting';
}

// ─── Badge ────────────────────────────────────────────────────────────────────

/**
 * Monitoring's badge is distinct from recording's red REC — the two can run at
 * once and must not look like the same thing. A capture problem turns it amber
 * so a broken session is visible without opening the popup.
 */
function setMonitoringBadge(): void {
  const broken =
    state.capture.status === 'reconnect' ||
    state.capture.status === 'failed' ||
    state.failedSnapshots > 0;
  const paused = state.status === 'paused';
  const text = broken ? 'MON!' : paused ? '❚❚' : 'MON';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({ color: broken ? '#d78706' : paused ? '#7a6cc4' : '#00829b' })
    .catch(() => {});
}

function clearMonitoringBadge(): void {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}
