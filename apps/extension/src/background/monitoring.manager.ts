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
 * bookkeeping (heartbeat, activity flush, capture watchdog) while the offscreen
 * document — which is NOT torn down — drives the 30/60s capture cadence.
 *
 * ── Session state and capture state are separate ─────────────────────────────
 * They fail independently. A session can be perfectly alive on the server while
 * the screen stream is dead, and reporting only the former is what let the UI
 * claim "Monitoring Active" with no screenshots for an hour. Both are tracked
 * and both are published.
 *
 * ── Inactivity starts at the threshold, not at last input ────────────────────
 * A user whose last keypress was 10:24 and who returns at 10:46 is reported
 * inactive 10:29–10:46. The first five minutes had not yet qualified as
 * anything, and back-dating them would over-report inactivity by the full
 * threshold on every single period.
 */

import { generateId } from '@/utils';
import {
  INITIAL_MONITORING_STATE,
  INACTIVITY_THRESHOLD_SECONDS,
  MONITORING_ALARMS,
  MONITORING_STORAGE_KEYS,
  type CaptureHealth,
  type MonitoringInterval,
  type MonitoringState,
  type NativeAgentState,
  type NativeActivity,
  type NativeIdleEvent,
} from '@/types/monitoring';
import {
  startMonitoring as apiStart,
  stopMonitoring as apiStop,
  pauseMonitoring as apiPause,
  resumeMonitoring as apiResume,
  sendHeartbeat,
  startInactivity,
  endInactivity,
  sendActivityBatch,
  getMonitoringProject,
  setMonitoringProject,
  MonitoringApiError,
} from '@/services/monitoring.api';
import { purgeSessionQueue, queueStats } from '@/utils/monitoringQueue';
import {
  configureUploader,
  drainSnapshotQueue,
  flushSnapshotQueue,
  startUploader,
  stopUploader,
} from './monitoring.uploader';
import {
  configureCaptureOffscreen,
  startCapture,
  stopCapture,
  pauseCapture,
  flushCapture,
  probeCapture,
  getCaptureHealth,
  setCaptureHealth,
  resetCaptureHealth,
  isCaptureStale,
} from './monitoring.capture';
import {
  configureNativeAgent,
  connectNativeAgent,
  startNativeMonitoring,
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
  flushActivityBuffer,
  clearActivityState,
  currentActivityLabel,
  bufferedActivityCount,
} from './monitoring.activity';

let state: MonitoringState = { ...INITIAL_MONITORING_STATE };
let hydrated = false;

/**
 * In-flight transitions.
 *
 * Returned to a second caller rather than beginning a rival lifecycle: two
 * concurrent starts would each open a screen picker and race to persist a
 * session id, and two concurrent stops would each try to settle the day.
 */
let startInFlight: Promise<MonitoringState> | null = null;
let stopInFlight: Promise<MonitoringState> | null = null;

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
  // Capture health lives in the offscreen document, which outlives the worker,
  // so a woken worker must ask rather than trust its own restored copy.
  if (state.status === 'monitoring') {
    const probed = await probeCapture();
    if (probed) await persist({ capture: probed });
  }
  return state;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

/**
 * Writes from the agent that are still in flight.
 *
 * The agent's messages arrive on a port callback, which cannot be awaited by
 * whoever is stopping the session. Without this, the stop could send the
 * buffered activity while the final interval was still being written to that
 * buffer, and then clear it.
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

/** Wait for those writes, so a flush means "buffered", not "sent". */
async function settleActivityWrites(): Promise<void> {
  while (pendingActivityWrites.size > 0) {
    await Promise.all([...pendingActivityWrites]);
  }
}

export function configureMonitoringOffscreen(bridge: {
  ensureDocument: () => Promise<void>;
  send: (type: string, payload?: unknown) => Promise<unknown>;
}): void {
  configureCaptureOffscreen(bridge);

  configureUploader({
    onStats: async (stats) => {
      await hydrate();
      await persist({
        queuedSnapshots: stats.pending,
        failedSnapshots: stats.failed,
        uploadError: stats.lastError,
      });
    },
    onStored: async (capturedAt) => {
      await hydrate();
      await persist({
        screenshotCount: state.screenshotCount + 1,
        lastScreenshotAt: capturedAt,
        offlineSince: null,
      });
    },
    onSessionInactive: () => {
      void stopMonitoringSession();
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
      void (async () => {
        await hydrate();
        if (state.status !== 'monitoring' || !state.project || !state.sessionId) return;

        if (event.idle) {
          if (state.openInactivityStartedAt) return;
          try {
            await startInactivity(state.project, state.sessionId, event.startedAt);
            await persist({ openInactivityStartedAt: event.startedAt });
          } catch (err) {
            if (
              err instanceof MonitoringApiError &&
              err.code === 'MONITORING_OVERLAPPING_INACTIVITY'
            ) {
              await persist({ openInactivityStartedAt: event.startedAt });
              return;
            }
            console.warn('[Monitoring] could not open inactive period:', err);
          }
          return;
        }

        if (!state.openInactivityStartedAt) return;
        try {
          await endInactivity(
            state.project,
            state.sessionId,
            event.endedAt ?? new Date().toISOString(),
          );
        } catch (err) {
          console.warn('[Monitoring] could not close inactive period:', err);
        }
        await persist({
          openInactivityStartedAt: null,
          lastActivityAt: event.endedAt ?? new Date().toISOString(),
        });
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

// ─── Start ────────────────────────────────────────────────────────────────────

/**
 * Begin a session.
 *
 * Order matters. The screen grant is requested BEFORE the backend session is
 * created: if the user cancels the picker there must be no orphaned session on
 * the server, and a session that cannot possibly capture is not a monitoring
 * session. The `clientSessionId` is persisted before the first request so every
 * retry reuses it and the idempotent `start` endpoint returns the same session
 * rather than opening a second one.
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
  await hydrate();

  if (state.status === 'monitoring' || state.status === 'paused') return state;
  if (state.status === 'stopping') {
    await persist({ error: 'The previous session is still stopping — try again in a moment.' });
    return state;
  }

  // The caller's explicit choice wins; the remembered project keeps non-UI
  // entry points working.
  const project = options.project ?? (await getMonitoringProject());
  if (!project) {
    await persist({ status: 'idle', error: 'Select a project before starting monitoring.' });
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
  });

  // ── 1. Backend session ───────────────────────────────────────────────────
  //
  // The screen is requested after this, not before. The picker is a modal the
  // user answers in their own time, and holding an unstarted session open
  // across it would leave the extension in `starting` with nothing on the
  // server if they wandered off. If they cancel, the session is stopped again
  // immediately below — which the backend handles as an ordinary short session
  // rather than an orphan.
  try {
    const response = await apiStart(
      project,
      clientSessionId,
      options.intervalSeconds,
      new Date().toISOString(),
    );
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
      screenshotCount: response.session.screenshotCount ?? 0,
      lastScreenshotAt: null,
      offlineSince: null,
      error: null,
    });
  } catch (err) {
    if (err instanceof MonitoringApiError && err.code === 'MONITORING_ALREADY_ACTIVE') {
      // A session is already running for this user. Re-read rather than
      // reporting a failure for something that is working.
      await persist({ status: 'monitoring', error: null });
    } else {
      const message = err instanceof Error ? err.message : 'Could not start monitoring';
      await persist({ status: 'idle', error: message });
      return state;
    }
  }

  // ── 2. Capture, activity, heartbeat ──────────────────────────────────────
  await beginCapture();

  // A session that cannot see the screen is not monitoring. If the user
  // cancelled the picker, end it now rather than leaving a live session
  // recording nothing but activity the user never agreed to.
  if (getCaptureHealth().status === 'idle' && state.capture.error) {
    await persist({ error: state.capture.error });
    return runStop();
  }

  // The agent is optional. A missing host degrades to browser-only activity,
  // which is still a useful session, so it must not block the start.
  //
  // Bound to the session id so intervals it reports can be attributed, and so
  // an agent restart can re-bind itself without the extension intervening.
  startNativeMonitoring(state.sessionId!, state.inactivityThresholdSeconds);

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

async function beginCapture(): Promise<void> {
  if (!state.sessionId || !state.project) return;
  const result = await startCapture({
    project: state.project,
    sessionId: state.sessionId,
    intervalSeconds: state.intervalSeconds,
  });

  // Uploading runs here in the worker, not in the offscreen document, and it
  // runs even when capture failed to start: a previous session may have left
  // frames queued, and those are still owed to the server.
  startUploader();

  await persist({
    capture: result.health,
    // Capture failing does not end the session — time, activity and inactivity
    // are still recorded — but the user must be told plainly, because a session
    // with no screenshots is not what they asked for.
    error: result.started ? null : (result.health.error ?? 'Screen capture could not be started.'),
  });
}

/**
 * Re-acquire the screen after the stream died.
 *
 * A new grant is genuinely required: a stopped track cannot be restarted, and
 * only the user can authorise a replacement. The session continues untouched,
 * so nothing already recorded is affected.
 */
export async function reconnectMonitoringCapture(): Promise<MonitoringState> {
  await hydrate();
  if (state.status !== 'monitoring' || !state.sessionId) return state;

  await persist({ capture: { ...state.capture, status: 'requesting', error: null } });
  // Re-acquiring genuinely re-prompts: a stopped track cannot be revived and
  // only the user can authorise a replacement. The session itself continues
  // untouched, so nothing already recorded is affected.
  await beginCapture();
  setMonitoringBadge();
  return state;
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

/**
 * Stop, flushing everything first.
 *
 * The order is the point: the open activity and inactive period are closed at
 * the true stop time, buffered data is sent, and outstanding uploads get a
 * bounded chance to finish — all *before* the backend session is settled.
 * Tearing capture down first would discard the last frames of the day.
 */
export function stopMonitoringSession(): Promise<MonitoringState> {
  if (stopInFlight) return stopInFlight;
  stopInFlight = runStop().finally(() => {
    stopInFlight = null;
  });
  return stopInFlight;
}

async function runStop(): Promise<MonitoringState> {
  await hydrate();
  if (state.status === 'idle') return state;

  const { project, sessionId } = state;
  // Flip first: this stops new activity events and new captures from being
  // treated as part of a live session.
  await persist({ status: 'stopping' });

  const stoppedAt = new Date();

  // 1. Close what is open, at the real stop time.
  //    Awaited: the agent emits an interval only when it ends, so for a session
  //    spent in a single application this flush produces the session's only
  //    activity row. Firing and forgetting sent it after step 2 had already
  //    flushed and cleared the buffer, and it was lost.
  await flushNativeAgent();
  await settleActivityWrites();
  await closeOpenActivity(stoppedAt);
  await closeOpenInactivity(stoppedAt);

  // 2. Send buffered activity.
  if (project && sessionId) {
    await flushActivityBuffer(
      (activities) => sendActivityBatch(project, sessionId, activities),
      (err) => !(err instanceof MonitoringApiError) || err.isRetryable,
    );
  }

  // 3. Take a final frame, then give everything queued a bounded chance to
  //    land. Both halves matter: the offscreen document can only capture, and
  //    only the worker can upload.
  await flushCapture();
  await flushSnapshotQueue();
  stopUploader();

  // 4. Only now may capture go.
  await stopCapture();
  stopNativeMonitoring();
  stopIdleDetection();

  // 5. Settle the session.
  if (project && sessionId) {
    try {
      await apiStop(project, sessionId, stoppedAt.toISOString());
    } catch (err) {
      // Stopping an already-stopped session is a server-side no-op, and a
      // network failure only means the backend expires it on its own. The local
      // session is over either way — leaving it "active" would be worse.
      console.warn('[Monitoring] stop request failed; session ended locally:', err);
    }
  }

  const stats = await queueStats().catch(() => null);
  if (sessionId && stats && stats.pending === 0) {
    await purgeSessionQueue(sessionId).catch(() => 0);
  }

  await chrome.alarms.clear(MONITORING_ALARMS.TICK);
  await clearActivityState();
  resetCaptureHealth();

  await persist({
    ...INITIAL_MONITORING_STATE,
    // Anything that could not be uploaded is real data loss, reported rather
    // than quietly forgotten with the rest of the session state.
    failedSnapshots: stats?.failed ?? 0,
    queuedSnapshots: stats?.pending ?? 0,
    uploadError: stats?.lastError ?? null,
  });
  clearMonitoringBadge();
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

  try {
    await apiPause(state.project, state.sessionId, at.toISOString());
  } catch (err) {
    console.warn('[Monitoring] pause request failed:', err);
  }

  await pauseCapture();
  stopIdleDetection();
  await persist({
    status: 'paused',
    pausedAt: at.toISOString(),
    capture: { ...getCaptureHealth(), status: 'idle' },
    currentActivityLabel: null,
  });
  setMonitoringBadge();
  return state;
}

/**
 * Resume.
 *
 * A fresh screen grant is required: pausing released the stream, and a stopped
 * track cannot be revived. Asking again is better than resuming into a session
 * that silently captures nothing.
 */
export async function resumeMonitoringSession(): Promise<MonitoringState> {
  await hydrate();
  if (state.status !== 'paused' || !state.project || !state.sessionId) return state;

  const at = new Date();
  try {
    await apiResume(state.project, state.sessionId, at.toISOString());
  } catch (err) {
    console.warn('[Monitoring] resume request failed:', err);
  }

  const pausedMs =
    state.pausedMs + (state.pausedAt ? at.getTime() - new Date(state.pausedAt).getTime() : 0);
  await persist({ status: 'monitoring', pausedAt: null, pausedMs });

  // Pausing released the stream, so resuming re-prompts. Asking again is
  // better than resuming into a session that silently captures nothing.
  await beginCapture();

  resumeNativeAgent();
  await initializeCurrentActivity({ nativeTracking: isNativeAgentTracking() });
  startIdleDetection();
  await armAlarm();
  await persist({ currentActivityLabel: await currentActivityLabel() });
  setMonitoringBadge();
  return state;
}

// ─── Alarm upkeep ─────────────────────────────────────────────────────────────

async function armAlarm(): Promise<void> {
  await chrome.alarms.create(MONITORING_ALARMS.TICK, { periodInMinutes: 1 });
}

/**
 * Heartbeat, activity flush, and the capture watchdog.
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

  // A paused session still heartbeats: the client IS alive, and letting it
  // expire during a legitimate pause would truncate the day.
  try {
    await sendHeartbeat(project, sessionId, {
      clientTime: new Date().toISOString(),
      lastActivityAt: state.lastActivityAt ?? undefined,
      lastSnapshotAt: state.lastScreenshotAt ?? undefined,
    });
    if (state.offlineSince) await persist({ offlineSince: null });
  } catch (err) {
    if (err instanceof MonitoringApiError && err.code === 'MONITORING_SESSION_NOT_ACTIVE') {
      console.warn('[Monitoring] session no longer active server-side — ending locally');
      await stopMonitoringSession();
      return;
    }
    if (!state.offlineSince) await persist({ offlineSince: new Date().toISOString() });
  }

  await flushActivityBuffer(
    (activities) => sendActivityBatch(project, sessionId, activities),
    (err) => !(err instanceof MonitoringApiError) || err.isRetryable,
  );

  if (state.status === 'monitoring') {
    await runCaptureWatchdog();
    // A port can stay nominally open while the agent process is wedged. The
    // heartbeat is the only evidence it is alive.
    recoverNativeAgentIfStale();
  }

  const stats = await queueStats().catch(() => null);
  await persist({
    queuedSnapshots: stats?.pending ?? 0,
    failedSnapshots: stats?.failed ?? 0,
    uploadError: stats?.lastError ?? null,
    currentActivityLabel: await currentActivityLabel(),
    native: getNativeAgentState(),
  });
  setMonitoringBadge();
}

/**
 * Is capture genuinely working?
 *
 * Three distinct failures, each needing a different answer:
 *  - the offscreen document is gone → its stream went with it; needs a re-grant
 *  - the track is dead              → only the user can grant a new screen
 *  - everything claims fine but no frame has landed in two intervals → say so
 */
async function runCaptureWatchdog(): Promise<void> {
  const probed = await probeCapture();

  if (!probed) {
    // The document holding the stream no longer exists, so capture is
    // definitely not happening whatever the last known health claimed. A
    // desktopCapture id is single-use once consumed, so this cannot be repaired
    // without the user — say so rather than silently capturing nothing.
    await persist({
      capture: {
        ...state.capture,
        status: 'reconnect',
        trackLive: false,
        error: 'Screen capture needs to be reconnected.',
      },
      error: 'Screen capture disconnected — no new screenshots are being captured.',
    });
    return;
  }

  setCaptureHealth(probed);

  if (probed.status === 'reconnect' || probed.status === 'failed') {
    await persist({
      capture: probed,
      error: 'Screen capture disconnected — no new screenshots are being captured.',
    });
    return;
  }

  if (isCaptureStale(state.intervalSeconds)) {
    await persist({
      capture: {
        ...probed,
        status: 'reconnect',
        error: 'No screenshot has been captured recently.',
      },
      error: 'Screen capture appears stalled — no new screenshots are being captured.',
    });
    return;
  }

  await persist({ capture: probed, error: null });
}

// ─── Inactivity ───────────────────────────────────────────────────────────────

/**
 * OS-level idleness, via `chrome.idle`.
 *
 * The `idle` event fires when the detection interval has elapsed with no
 * keyboard or pointer input anywhere on the machine — the only honest
 * definition, since a user typing in another application would look idle to any
 * browser-event heuristic.
 *
 * The period starts NOW, at the moment the threshold is reached — never
 * back-dated to the last input, which would add the full threshold to every
 * inactive period the report shows.
 */
function onIdleStateChanged(newState: chrome.idle.IdleState): void {
  void (async () => {
    await hydrate();
    if (state.status !== 'monitoring' || !state.project || !state.sessionId) return;

    // The agent owns inactivity whenever it is connected and can measure it:
    // it reports a real OS-wide duration, while chrome.idle can only say a
    // threshold was crossed. Running both would open two overlapping periods
    // for one absence, which the backend rejects as overlapping.
    if (nativeOwnsIdleDetection()) return;

    if (newState === 'active') {
      await closeOpenInactivity(new Date());
      await persist({ lastActivityAt: new Date().toISOString() });
      return;
    }

    // 'idle' or 'locked' — a locked screen is unambiguously away-from-keyboard.
    if (state.openInactivityStartedAt) return;

    const startedAt = new Date().toISOString();
    try {
      await startInactivity(state.project, state.sessionId, startedAt);
      await persist({ openInactivityStartedAt: startedAt });
    } catch (err) {
      if (err instanceof MonitoringApiError && err.code === 'MONITORING_OVERLAPPING_INACTIVITY') {
        // The server already has this stretch; treat it as open so the matching
        // `end` is still sent.
        await persist({ openInactivityStartedAt: startedAt });
        return;
      }
      console.warn('[Monitoring] could not open inactive period:', err);
      await persist({ error: 'An inactivity period could not be recorded.' });
    }
  })();
}

async function closeOpenInactivity(at: Date): Promise<void> {
  if (!state.openInactivityStartedAt || !state.project || !state.sessionId) return;
  try {
    // A stretch that turns out to be under the threshold is discarded by the
    // server (204), which is why nothing is filtered here.
    await endInactivity(state.project, state.sessionId, at.toISOString());
  } catch (err) {
    console.warn('[Monitoring] could not close inactive period:', err);
  }
  await persist({ openInactivityStartedAt: null });
}

function startIdleDetection(): void {
  // chrome.idle enforces a 15s floor and is only the fallback for when the
  // native agent is absent; the agent reports the true duration instead.
  chrome.idle.setDetectionInterval(Math.max(15, state.inactivityThresholdSeconds));
  if (!chrome.idle.onStateChanged.hasListener(onIdleStateChanged)) {
    chrome.idle.onStateChanged.addListener(onIdleStateChanged);
  }
}

function stopIdleDetection(): void {
  if (chrome.idle.onStateChanged.hasListener(onIdleStateChanged)) {
    chrome.idle.onStateChanged.removeListener(onIdleStateChanged);
  }
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
        offlineSince: null,
      });
      return;
    }

    case 'OFFSCREEN_MONITORING_SNAPSHOT_ENQUEUED': {
      // A frame just landed in the queue. Uploading is the worker's job — the
      // offscreen document cannot do it, because after an extension reload it
      // keeps its stream but loses `chrome.storage` along with every other
      // namespace it would need to authenticate.
      void drainSnapshotQueue();
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
      // ability to take NEW screenshots, which needs the user to re-grant.
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
 * re-created rather than assumed. The *stream* normally does survive — it lives
 * in the offscreen document, not here — which is why capture health is probed
 * instead of being reset, and only a genuinely unreachable document downgrades
 * the session to "reconnect".
 */
export async function restoreMonitoringSession(): Promise<void> {
  state = await readState();
  hydrated = true;
  if (state.status !== 'monitoring' && state.status !== 'paused') return;

  await armAlarm();
  if (state.status === 'monitoring') {
    startIdleDetection();
    // Re-open the port and re-bind the session: the port does not survive a
    // worker teardown, but the agent process and its session binding do.
    if (state.sessionId) {
      startNativeMonitoring(state.sessionId, state.inactivityThresholdSeconds);
    } else {
      connectNativeAgent();
    }
    const probed = await probeCapture();
    if (probed) {
      await persist({ capture: probed, native: getNativeAgentState() });
    } else {
      await persist({
        capture: {
          ...state.capture,
          status: 'reconnect',
          trackLive: false,
          error: 'Screen capture needs to be reconnected.',
        },
      });
    }
  }
  setMonitoringBadge();

  const buffered = await bufferedActivityCount().catch(() => 0);
  if (buffered > 0) console.log(`[Monitoring] restored with ${buffered} buffered activities`);
}

/**
 * Is a session live?
 *
 * Used by the offscreen-document owner check: recording finishing must not
 * close a document that is holding a monitoring stream.
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
