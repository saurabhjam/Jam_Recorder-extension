/**
 * Screen monitoring — extension-side types.
 *
 * The extension is the only client that can produce monitoring data: the only
 * one that can see a screen, sample OS-level idleness, and follow the user
 * between tabs. The portal reads what is recorded here and never writes it.
 *
 * ── Two independent state machines, on purpose ───────────────────────────────
 * A monitoring *session* and the *screen capture* feeding it can fail
 * separately, and conflating them is what let the UI claim "Monitoring Active"
 * while no screenshot had been taken for an hour. So `MonitoringStatus`
 * describes the session (which the backend knows about) and `CaptureStatus`
 * describes the stream (which only this machine knows about). Both are reported
 * to the UI, and the UI must show both.
 *
 * Field names on the API payload types mirror the wire format exactly, so a
 * payload can be handed to `fetch` without a translation layer that could
 * silently rename something.
 */

// ─── API resources ────────────────────────────────────────────────────────────

export type MonitoringSessionStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'EXPIRED';
export type MonitoringReportStatus = 'OPEN' | 'COMPLETED' | 'PARTIAL';
export type MonitoringActivityType = 'WEBSITE' | 'PAGE' | 'APPLICATION';

/** Only 30 and 60 are accepted; anything else is MONITORING_INVALID_INTERVAL. */
export type MonitoringInterval = 30 | 60;

export const MONITORING_INTERVALS: MonitoringInterval[] = [30, 60];

export interface MonitoringSessionResource {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  pausedSeconds: number;
  screenshotCount: number;
  inactiveSeconds: number;
  activityCount: number;
  intervalSeconds: number;
  status: MonitoringSessionStatus;
  lastHeartbeatAt: string | null;
}

export interface DailyMonitoringReportResource {
  id: string | null;
  userId: number;
  userName: string;
  projectId: number;
  reportDate: string;
  reportZone: string;
  totalMonitoringSeconds: number;
  totalInactiveSeconds: number;
  totalScreenshotCount: number;
  totalActivityCount: number;
  sessionCount: number;
  status: MonitoringReportStatus;
}

export interface StartMonitoringResponse {
  dailyReport: DailyMonitoringReportResource;
  session: MonitoringSessionResource;
  /**
   * Seconds without input after which a stretch counts as inactive.
   *
   * The server's value, used in preference to the local default: the server
   * rejects any period shorter than its own threshold, so a client holding a
   * smaller number has every period it reports silently dropped. Absent on an
   * older server, which is what the local default covers.
   */
  inactivityThresholdSeconds?: number;
}

export interface SnapshotUploadResponse {
  snapshotId: string;
  /** Signed storage URL under `DIRECT`; null under `PROXY`. */
  uploadUrl: string | null;
  storageKey: string;
  expiresAt: string;
  uploadMethod: string;
  /**
   * Where the bytes go.
   *
   * `DIRECT` is a signed PUT straight to object storage. `PROXY` sends them
   * through the API instead, which is what a deployment whose storage has no
   * public HTTPS address requires — a signed URL over an in-cluster host is
   * unopenable from a browser and fails as an opaque network error.
   *
   * Absent on an older server, which only ever meant `DIRECT`.
   */
  uploadStrategy?: 'DIRECT' | 'PROXY';
}

/**
 * One observed stretch of a website, page or application being in front.
 *
 * `source` is not cosmetic: an EXTENSION row knows a page in *this* Chrome
 * profile, a NATIVE_AGENT row knows the real foreground application. A report
 * that cannot tell them apart cannot say whether "Google Chrome, 3h" means the
 * browser was in front or merely that a tab was open.
 */
export type MonitoringActivitySource = 'EXTENSION' | 'NATIVE_AGENT';

export interface MonitoringActivityPayload {
  clientActivityId: string;
  activityType: MonitoringActivityType;
  source: MonitoringActivitySource;
  applicationName?: string;
  applicationId?: string;
  processId?: number;
  browserName?: string;
  browserProfile?: string;
  windowTitle?: string;
  domain?: string;
  url?: string;
  pageTitle?: string;
  startedAt: string;
  endedAt: string;
}

export interface ActivityBatchResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
  errors: string[];
}

// ─── Session state machine ────────────────────────────────────────────────────

/**
 * Where the *session* is.
 *
 * `starting` and `stopping` are real states rather than transient booleans
 * because both span several awaited network calls, and a second Start or Stop
 * arriving mid-transition must be recognised and coalesced rather than starting
 * a rival lifecycle.
 */
export type MonitoringStatus = 'idle' | 'starting' | 'monitoring' | 'paused' | 'stopping' | 'error';

// ─── Capture state machine ────────────────────────────────────────────────────

/**
 * Where the *screen capture* is.
 *
 * Deliberately never derived from "is there a timer object". A timer can be
 * scheduled while the underlying video track is dead, and a timer can be
 * momentarily null while a capture is in flight — so neither answers "are
 * screenshots actually being taken". Only an explicit state does.
 *
 *   idle        no capture wanted
 *   requesting  waiting for the user to grant the screen
 *   active      stream live, scheduler armed
 *   capturing   grabbing a frame right now
 *   reconnect   stream died; needs a fresh user grant to continue
 *   failed      capture cannot proceed and the user must act
 *   stopped     deliberately torn down
 */
export type CaptureStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'capturing'
  | 'reconnect'
  | 'failed'
  | 'stopped';

/**
 * Everything the UI needs to tell the truth about capture health.
 *
 * `lastSuccessfulCaptureAt` is separate from `lastCaptureAttemptAt` because the
 * gap between them is exactly the signal that something is wrong while the
 * session still looks alive.
 */
export interface CaptureHealth {
  status: CaptureStatus;
  /** `live` reading of the actual MediaStreamTrack, not an inference. */
  trackLive: boolean;
  lastCaptureAttemptAt: string | null;
  lastSuccessfulCaptureAt: string | null;
  nextCaptureAt: string | null;
  successfulCaptureCount: number;
  failedCaptureCount: number;
  /** Deadlines skipped because the previous capture was still running. */
  deferredCaptureCount: number;
  error: string | null;
}

export const INITIAL_CAPTURE_HEALTH: CaptureHealth = {
  status: 'idle',
  trackLive: false,
  lastCaptureAttemptAt: null,
  lastSuccessfulCaptureAt: null,
  nextCaptureAt: null,
  successfulCaptureCount: 0,
  failedCaptureCount: 0,
  deferredCaptureCount: 0,
  error: null,
};

// ─── Activity ─────────────────────────────────────────────────────────────────

/**
 * The activity interval currently open.
 *
 * Persisted, not merely held in a module variable: an MV3 worker is torn down
 * constantly, and losing this means losing every minute since the last focus
 * change — which for someone reading one long document is the entire session.
 *
 * `source` records where the facts came from, and it is not cosmetic. A
 * `native` interval knows the real foreground application; an `extension`
 * interval knows only that a tab in *this* profile was active. Reporting the
 * latter as though it were the former would claim knowledge we do not have.
 */
export interface OpenActivity {
  source: 'native' | 'extension';
  activityType: MonitoringActivityType;
  applicationName?: string;
  domain?: string;
  url?: string;
  pageTitle?: string;
  /** Chrome profile name, when the native agent could read it. */
  profileName?: string;
  startedAt: string;
  /** Stable identity — a change here closes the interval and opens a new one. */
  identity: string;
}

// ─── Native agent ─────────────────────────────────────────────────────────────

/** Native messaging host id. Must match the installed host manifest exactly. */
export const NATIVE_HOST_NAME = 'com.bestq.monitoring';

/**
 * Wire contract version.
 *
 * A mismatch is refused rather than best-effort parsed: half understanding a
 * newer agent would report partial activity, and partial activity in somebody's
 * work record is worse than an explicit "Update Required".
 */
export const NATIVE_PROTOCOL_VERSION = 1;

/** Oldest agent build this extension will work with. */
export const MIN_AGENT_VERSION = '1.0.0';

/**
 * Reconnect ladder, in milliseconds.
 *
 * Tops out and stays there. An agent restarted by an upgrade is picked up
 * within half a minute; an agent that never returns does not have the extension
 * launching a process every second for the rest of the day.
 */
export const NATIVE_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * The agent's connection state.
 *
 * Separate from both the session and the screen capture, because all three fail
 * independently — and the UI must be able to say which one is broken.
 */
export type NativeAgentStatus =
  | 'unknown'
  | 'unavailable'
  | 'connecting'
  | 'connected'
  | 'monitoring'
  | 'disconnected'
  | 'permission-required'
  | 'unsupported-platform'
  | 'outdated'
  | 'error';

/**
 * What this machine can actually report, probed at runtime by the agent.
 *
 * Never assumed from the OS name: macOS reports windowTitle=false until
 * Accessibility is granted, and Wayland reports foregroundApplication=false
 * rather than pretending X11 tooling works there.
 */
export interface NativeCapabilities {
  foregroundApplication: boolean;
  windowTitle: boolean;
  processIdentifier: boolean;
  browserProfile: boolean;
  /**
   * Always false. A window title is not a URL, and for a Chrome profile this
   * extension is not installed in there is no way to obtain one. Pinned in the
   * validator so a claim of `true` from the wire cannot get through.
   */
  exactBrowserUrl: false;
  idleDetection: boolean;
}

/** OS grants the agent needs, as observed now. Absent means "not required here". */
export interface NativePermissions {
  accessibility?: boolean;
  x11Tools?: boolean;
}

export interface NativeAgentState {
  status: NativeAgentStatus;
  agentVersion: string | null;
  platform: string | null;
  architecture: string | null;
  capabilities?: NativeCapabilities;
  permissions?: NativePermissions;
  lastHeartbeatAt: string | null;
  error: string | null;
}

export const INITIAL_NATIVE_AGENT_STATE: NativeAgentState = {
  status: 'unknown',
  agentVersion: null,
  platform: null,
  architecture: null,
  lastHeartbeatAt: null,
  error: null,
};

/**
 * One closed focus interval from the agent.
 *
 * `browserName`, `browserProfile`, `windowTitle` and page identity are separate
 * optional fields on purpose. The agent knows a browser was frontmost and can
 * often read its page title and profile; it never knows the URL. Collapsing
 * them into one "page" field would invite exactly the fabrication that must not
 * happen — so there is no `pageUrl` here at all.
 */
export interface NativeActivity {
  applicationName: string;
  applicationId?: string;
  processId?: number;
  windowTitle?: string;
  browserName?: string;
  browserProfile?: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  /** True for applications whose titles are dropped wholesale (password managers). */
  titleSuppressed?: boolean;
  /** Idempotency key the backend dedupes on. */
  clientActivityId: string;
  sessionId?: string;
}

/**
 * A system-wide inactivity transition.
 *
 * `startedAt` is when input actually stopped — earlier than when the threshold
 * was reached. The threshold decides *whether* to record; the OS idle counter
 * decides *what* to record.
 */
export interface NativeIdleEvent {
  idle: boolean;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
}

// ─── Persisted session state ──────────────────────────────────────────────────

export interface MonitoringState {
  status: MonitoringStatus;
  /** Our idempotency key for `start`. Reused verbatim on every retry. */
  clientSessionId: string | null;
  sessionId: string | null;
  dailyReportId: string | null;
  /** Project *name* — the path segment, fixed for the life of the session. */
  project: string | null;
  intervalSeconds: MonitoringInterval;
  /** Server-reported start, so elapsed time never depends on the client clock. */
  startedAt: string | null;
  pausedMs: number;
  pausedAt: string | null;
  screenshotCount: number;
  lastScreenshotAt: string | null;
  lastActivityAt: string | null;
  /** Start of the inactive stretch currently open on the server, if any. */
  openInactivityStartedAt: string | null;
  /** Set when the last sync attempt failed, so the UI can say "syncing". */
  offlineSince: string | null;
  capture: CaptureHealth;
  native: NativeAgentState;
  /** The server's inactivity threshold for this session, in seconds. */
  inactivityThresholdSeconds: number;
  /** Screenshots captured but not yet confirmed to the server. */
  queuedSnapshots: number;
  /** Screenshots that will never upload — real data loss, surfaced separately. */
  failedSnapshots: number;
  /**
   * Why the last upload attempt failed, shown under the counts.
   *
   * A count alone is not actionable — "4 could not be uploaded" is the same
   * message whether storage is unreachable, the token expired or the session
   * ended, and the distinction was previously visible only inside the
   * offscreen document's IndexedDB.
   */
  uploadError: string | null;
  /** What is in front right now, for display only. */
  currentActivityLabel: string | null;
  error: string | null;
}

/**
 * Fallback inactivity threshold, in seconds.
 *
 * Two minutes. The server sends the real value on session start and that one
 * wins; this only covers a server too old to send it. Both sides must agree,
 * because the server drops any period shorter than its own threshold.
 *
 * Declared above INITIAL_MONITORING_STATE on purpose: that object reads this at
 * module-evaluation time, and a `const` declared after its use is in the
 * temporal dead zone. In a service worker that is not a subtle bug — the module
 * throws on load and the worker fails to register at all.
 */
export const INACTIVITY_THRESHOLD_SECONDS = 120;

export const INITIAL_MONITORING_STATE: MonitoringState = {
  status: 'idle',
  clientSessionId: null,
  sessionId: null,
  dailyReportId: null,
  project: null,
  intervalSeconds: 60,
  startedAt: null,
  pausedMs: 0,
  pausedAt: null,
  screenshotCount: 0,
  lastScreenshotAt: null,
  lastActivityAt: null,
  openInactivityStartedAt: null,
  offlineSince: null,
  capture: INITIAL_CAPTURE_HEALTH,
  native: INITIAL_NATIVE_AGENT_STATE,
  inactivityThresholdSeconds: INACTIVITY_THRESHOLD_SECONDS,
  queuedSnapshots: 0,
  failedSnapshots: 0,
  uploadError: null,
  currentActivityLabel: null,
  error: null,
};

// ─── Storage + alarms ─────────────────────────────────────────────────────────

export const MONITORING_STORAGE_KEYS = {
  STATE: 'st_monitoring_state',
  ACTIVITY_BUFFER: 'st_monitoring_activity',
  OPEN_ACTIVITY: 'st_monitoring_open_activity',
  /**
   * The project this session writes to.
   *
   * Monitoring keeps its OWN key rather than sharing `st_auth_project` with
   * recording. The offscreen upload path falls back to writing the literal
   * `superadmin_personal` into that shared key when it cannot resolve a
   * project, which then silently became the monitoring project too — the popup
   * showed a live session attributed to `superadmin_personal` even though the
   * user had picked a real project from their assigned list.
   */
  PROJECT: 'st_monitoring_project',
} as const;

/**
 * Alarms, not `setInterval`: a stopped MV3 worker does not run timers, and
 * Chrome guarantees an alarm wakes it. The one-minute floor is why the alarm
 * does bookkeeping (heartbeat, flush, watchdog) and the offscreen document —
 * which stays alive — drives the 30/60s capture cadence.
 */
export const MONITORING_ALARMS = {
  TICK: 'st_monitoring_tick',
} as const;

/** Max activities per batch request, per the API contract. */
export const ACTIVITY_BATCH_MAX = 500;

/** Heartbeat cadence. The server expires a session after 15 minutes of silence. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
