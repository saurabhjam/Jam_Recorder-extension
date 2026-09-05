/**
 * The single connection to the BestQ desktop monitoring agent.
 *
 * ── Why an agent is needed at all ────────────────────────────────────────────
 * `chrome.tabs`, `chrome.windows` and `chrome.webNavigation` describe the
 * browser and nothing else. An extension cannot see VS Code, Slack, a terminal,
 * or a tab in a different Chrome profile — so it cannot answer "which
 * application was in use, and for how long", and it must not claim to. The
 * agent runs on the machine, asks the OS, and reports over Native Messaging.
 *
 * ── Exactly one port ────────────────────────────────────────────────────────
 * Every native call in the extension goes through this module. Two
 * `connectNative` calls would launch two agent processes, each sampling the
 * same desktop and each emitting its own intervals — the activity timeline
 * would double-count everything.
 *
 * ── The agent is optional, and its absence is a normal state ─────────────────
 * A machine without the agent installed still gets screenshots and
 * browser-profile activity. `unavailable` is therefore reported plainly so the
 * UI can offer the installer, not retried forever as though it were a fault.
 * Screen capture and the agent fail independently and are surfaced separately.
 */

import {
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL_VERSION,
  INITIAL_NATIVE_AGENT_STATE,
  NATIVE_RECONNECT_BACKOFF_MS,
  MIN_AGENT_VERSION,
  type NativeActivity,
  type NativeAgentState,
  type NativeCapabilities,
  type NativeIdleEvent,
  type NativePermissions,
} from '@/types/monitoring';

interface Handlers {
  onActivity: (activity: NativeActivity) => void;
  onIdle: (event: NativeIdleEvent) => void;
  onStateChange: (state: NativeAgentState) => void;
}

let port: chrome.runtime.Port | null = null;
let handlers: Handlers | null = null;
let state: NativeAgentState = { ...INITIAL_NATIVE_AGENT_STATE };

/** The session the agent is monitoring, so a reconnect can re-bind it. */
let boundSessionID: string | null = null;
let idleThresholdSeconds = 0;

/** Reconnect bookkeeping. */
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wantConnection = false;

/** Last heartbeat, so a silent-but-open port is still detectable. */
let lastHeartbeatAt = 0;

export function configureNativeAgent(next: Handlers): void {
  handlers = next;
}

export function getNativeAgentState(): NativeAgentState {
  return state;
}

/** Is application-level activity genuinely available right now? */
export function isNativeAgentTracking(): boolean {
  return state.status === 'monitoring' || state.status === 'connected';
}

/**
 * Does the agent own inactivity detection?
 *
 * When it does, `chrome.idle` must not also report: the agent measures real
 * OS-wide idle *duration* while chrome.idle only signals a threshold crossing,
 * and running both would produce two overlapping inactive periods for one
 * absence — which the backend would reject as overlapping, or worse, accept.
 */
export function nativeOwnsIdleDetection(): boolean {
  return isNativeAgentTracking() && state.capabilities?.idleDetection === true;
}

/** Resolvers waiting on a FLUSHED acknowledgement. */
const pendingFlushes = new Set<() => void>();

function setState(patch: Partial<NativeAgentState>): void {
  state = { ...state, ...patch };
  handlers?.onStateChange(state);
}

// ─── Message validation ───────────────────────────────────────────────────────

/**
 * Nothing from the port is trusted.
 *
 * The agent is a separate process on the user's machine; a compromised or
 * simply buggy build must not be able to inject arbitrary strings into stored
 * activity. Every field is checked and bounded before it reaches the buffer.
 */
const MAX_FIELD_LENGTH = 512;

function asString(value: unknown, max = MAX_FIELD_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** ISO-8601 within a sane window. A timestamp years out is a bug or an attack. */
function asTimestamp(value: unknown): string | undefined {
  const text = asString(value, 40);
  if (!text) return undefined;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return undefined;
  const now = Date.now();
  // A day back covers a session that crossed midnight; five minutes forward
  // covers ordinary clock skew. Anything else is not a real observation.
  if (ms < now - 24 * 60 * 60 * 1000 || ms > now + 5 * 60 * 1000) return undefined;
  return new Date(ms).toISOString();
}

function validateActivity(raw: unknown): NativeActivity | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;

  const applicationName = asString(a.applicationName, 200);
  const startedAt = asTimestamp(a.startedAt);
  const endedAt = asTimestamp(a.endedAt);
  const clientActivityId = asString(a.clientActivityId, 128);
  if (!applicationName || !startedAt || !endedAt || !clientActivityId) return null;

  // A negative or absurd duration means the agent's clock or arithmetic is
  // wrong; the interval is dropped rather than stored as nonsense.
  const durationSeconds = Number(a.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 24 * 3600) {
    return null;
  }
  if (Date.parse(endedAt) < Date.parse(startedAt)) return null;

  const processId = Number(a.processId);

  return {
    applicationName,
    applicationId: asString(a.applicationId, 200),
    processId: Number.isInteger(processId) && processId > 0 ? processId : undefined,
    windowTitle: asString(a.windowTitle),
    browserName: asString(a.browserName, 100),
    browserProfile: asString(a.browserProfile, 200),
    // Deliberately never read from the wire. The agent does not produce a URL
    // and must not be able to introduce one — a page attributed to the wrong
    // Chrome profile would be a false statement about somebody's day.
    startedAt,
    endedAt,
    durationSeconds: Math.round(durationSeconds),
    titleSuppressed: a.titleSuppressed === true,
    clientActivityId,
    sessionId: asString(a.sessionId, 64),
  };
}

function validateIdle(raw: Record<string, unknown>): NativeIdleEvent | null {
  if (typeof raw.idle !== 'boolean') return null;
  const startedAt = asTimestamp(raw.idleStartedAt);
  if (!startedAt) return null;
  if (raw.idle) return { idle: true, startedAt };

  const endedAt = asTimestamp(raw.idleEndedAt);
  if (!endedAt) return null;
  const seconds = Number(raw.idleSeconds);
  return {
    idle: false,
    startedAt,
    endedAt,
    durationSeconds:
      Number.isFinite(seconds) && seconds >= 0 && seconds <= 24 * 3600
        ? Math.round(seconds)
        : undefined,
  };
}

function validateCapabilities(raw: unknown): NativeCapabilities | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const flag = (v: unknown): boolean => v === true;
  return {
    foregroundApplication: flag(c.foregroundApplication),
    windowTitle: flag(c.windowTitle),
    processIdentifier: flag(c.processIdentifier),
    browserProfile: flag(c.browserProfile),
    // Pinned false regardless of what the agent claims. No platform can supply
    // this, so a `true` here would be a bug or a lie either way.
    exactBrowserUrl: false,
    idleDetection: flag(c.idleDetection),
  };
}

function validatePermissions(raw: unknown): NativePermissions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const result: NativePermissions = {};
  if (typeof p.accessibility === 'boolean') result.accessibility = p.accessibility;
  if (typeof p.x11Tools === 'boolean') result.x11Tools = p.x11Tools;
  return result;
}

/** Semver-ish comparison. Returns true when `version` is at least `minimum`. */
export function meetsMinimumVersion(version: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v
      .split('.')
      .slice(0, 3)
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

// ─── Port lifecycle ───────────────────────────────────────────────────────────

function post(message: Record<string, unknown>): void {
  if (!port) return;
  try {
    port.postMessage({ protocolVersion: NATIVE_PROTOCOL_VERSION, ...message });
  } catch {
    // The port died between the check and the send; onDisconnect has already
    // recorded why and scheduled a reconnect.
    port = null;
  }
}

function handleMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const msg = raw as Record<string, unknown>;

  // A version the extension does not speak is refused outright. Half
  // understanding a newer agent would report partial activity, which is worse
  // than telling the user to update.
  if (msg.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    setState({
      status: 'outdated',
      error: `The monitoring agent speaks protocol ${String(msg.protocolVersion)}; this extension needs ${NATIVE_PROTOCOL_VERSION}.`,
    });
    disconnectNativeAgent();
    return;
  }

  switch (msg.type) {
    case 'READY': {
      const capabilities = validateCapabilities(msg.capabilities);
      const permissions = validatePermissions(msg.permissions);
      const agentVersion = asString(msg.agentVersion, 32) ?? '0.0.0';

      if (!meetsMinimumVersion(agentVersion, MIN_AGENT_VERSION)) {
        setState({
          status: 'outdated',
          agentVersion,
          platform: asString(msg.platform, 32) ?? null,
          error: `Agent ${agentVersion} is older than the required ${MIN_AGENT_VERSION}.`,
        });
        return;
      }

      reconnectAttempt = 0;
      lastHeartbeatAt = Date.now();

      // A connected agent that cannot see the foreground window is not usable
      // for application tracking; say which of the two reasons it is.
      const usable = capabilities?.foregroundApplication === true;
      setState({
        status: usable ? 'connected' : 'permission-required',
        agentVersion,
        platform: asString(msg.platform, 32) ?? null,
        architecture: asString(msg.architecture, 32) ?? null,
        capabilities,
        permissions,
        lastHeartbeatAt: new Date().toISOString(),
        error: usable ? null : state.error,
      });

      // Re-bind the session automatically. This is what makes an agent restart
      // invisible: the extension does not need to be told, it just re-issues
      // the START it already knows about.
      if (boundSessionID) {
        post({
          type: 'START_MONITORING',
          sessionId: boundSessionID,
          idleThresholdSeconds: idleThresholdSeconds || undefined,
        });
      }
      return;
    }

    case 'STARTED':
      setState({ status: 'monitoring', error: null });
      return;

    case 'STOPPED':
      setState({ status: isNativeAgentTracking() ? 'connected' : state.status });
      return;

    case 'ACTIVITY_CHANGED': {
      const activity = validateActivity(msg.activity);
      if (!activity) {
        console.warn('[NativeAgent] rejected a malformed activity record');
        return;
      }
      // An interval for a session we are not monitoring belongs to nothing.
      if (boundSessionID && activity.sessionId && activity.sessionId !== boundSessionID) {
        console.warn('[NativeAgent] dropped an activity for a different session');
        return;
      }
      handlers?.onActivity(activity);
      return;
    }

    case 'IDLE_CHANGED': {
      const event = validateIdle(msg);
      if (!event) {
        console.warn('[NativeAgent] rejected a malformed idle event');
        return;
      }
      handlers?.onIdle(event);
      return;
    }

    case 'FLUSHED':
      // Every interval the flush produced has already been delivered above as
      // ACTIVITY_CHANGED, so by the time this arrives the buffer is complete.
      pendingFlushes.forEach((resolve) => resolve());
      return;

    case 'HEARTBEAT':
      lastHeartbeatAt = Date.now();
      // Capabilities ride along, so a permission granted mid-session takes
      // effect here too. Held to the same validation as the initial READY —
      // and the previous value is kept if a heartbeat omits them, so an older
      // agent that sends a bare heartbeat does not blank what it reported.
      setState({
        lastHeartbeatAt: new Date().toISOString(),
        capabilities: validateCapabilities(msg.capabilities) ?? state.capabilities,
        permissions: validatePermissions(msg.permissions) ?? state.permissions,
      });
      return;

    case 'STATUS':
      setState({
        capabilities: validateCapabilities(msg.capabilities) ?? state.capabilities,
        permissions: validatePermissions(msg.permissions) ?? state.permissions,
      });
      return;

    case 'ERROR': {
      const code = asString(msg.code, 64);
      const message = asString(msg.message, 300);
      if (code === 'PERMISSION_REQUIRED') {
        setState({ status: 'permission-required', error: message ?? 'A permission is required.' });
      } else if (code === 'UNSUPPORTED_PLATFORM') {
        setState({ status: 'unsupported-platform', error: message ?? null });
      } else {
        setState({ error: message ?? 'The monitoring agent reported an error.' });
      }
      return;
    }

    default:
      // Unknown but well-formed: a newer agent being additive. Ignored rather
      // than treated as a fault.
      return;
  }
}

function handleDisconnect(): void {
  const reason = chrome.runtime.lastError?.message ?? null;
  port = null;

  // "Specified native messaging host not found" is the expected message when
  // the agent was never installed. That is a state to report, not an error to
  // keep retrying — so it stops the backoff.
  const notInstalled = Boolean(reason && /not found|not installed/i.test(reason));

  setState({
    status: notInstalled ? 'unavailable' : 'disconnected',
    lastHeartbeatAt: state.lastHeartbeatAt,
    error: reason,
  });

  if (notInstalled || !wantConnection) return;
  scheduleReconnect();
}

/**
 * Reconnect with bounded exponential backoff.
 *
 * The ladder tops out and stays there rather than growing forever: an agent
 * that comes back after an upgrade should be picked up within half a minute,
 * and an agent that never comes back should not have the extension spawning a
 * process launch every second for eight hours.
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay =
    NATIVE_RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, NATIVE_RECONNECT_BACKOFF_MS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!wantConnection) return;
    connectNativeAgent();
  }, delay);
}

/**
 * Open the port, if the agent is installed.
 *
 * Never throws: a missing agent must not prevent a monitoring session from
 * starting, because screenshots plus browser activity is still a useful session.
 */
export function connectNativeAgent(): void {
  wantConnection = true;
  if (port) return;
  setState({ status: 'connecting', error: null });

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    port = null;
    setState({
      status: 'unavailable',
      error: err instanceof Error ? err.message : 'The monitoring agent is not installed.',
    });
    return;
  }

  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(handleDisconnect);
  // Ask what it can do before relying on it, so an unsupported platform or a
  // missing permission is known immediately rather than inferred from silence.
  post({ type: 'HELLO' });
}

/** Bind the agent to a monitoring session. */
export function startNativeMonitoring(sessionId: string, thresholdSeconds: number): void {
  boundSessionID = sessionId;
  idleThresholdSeconds = thresholdSeconds;
  connectNativeAgent();
  post({
    type: 'START_MONITORING',
    sessionId,
    idleThresholdSeconds: thresholdSeconds || undefined,
  });
}

export function pauseNativeAgent(): void {
  post({ type: 'PAUSE_MONITORING' });
}

export function resumeNativeAgent(): void {
  post({ type: 'RESUME_MONITORING' });
}

/**
 * Close the agent's open interval.
 *
 * Called immediately before the backend session is settled, so the final
 * stretch of work is reported with its true end time instead of being lost.
 */
/**
 * Ask the agent to close and emit its open interval, and wait for it to do so.
 *
 * Awaiting matters. The agent only emits an interval when it *ends*, so a
 * session spent entirely in one application produces exactly one interval,
 * closed by this flush. Sending FLUSH without waiting meant that interval
 * arrived after the activity buffer had already been sent and cleared — so the
 * whole session's application time was dropped. Sessions that happened to
 * contain a focus change kept their earlier intervals and lost only the last,
 * which is why the report showed an application row for some sessions and
 * none at all for others.
 *
 * Resolves on the agent's FLUSHED acknowledgement, or on timeout: a stop must
 * not hang on an agent that has stopped answering.
 */
export function flushNativeAgent(timeoutMs = 3000): Promise<void> {
  if (!isNativeAgentTracking()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      pendingFlushes.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    pendingFlushes.add(done);
    post({ type: 'FLUSH' });
  });
}

export function requestNativeStatus(): void {
  post({ type: 'GET_STATUS' });
}

/** Unbind the session and close the port. */
export function stopNativeMonitoring(): void {
  if (boundSessionID) post({ type: 'STOP_MONITORING', sessionId: boundSessionID });
  boundSessionID = null;
  disconnectNativeAgent();
}

export function disconnectNativeAgent(): void {
  wantConnection = false;
  reconnectAttempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    port = null;
  }
  setState({ ...INITIAL_NATIVE_AGENT_STATE });
}

/**
 * Is the port open but silent?
 *
 * A port can stay nominally connected while the agent process is wedged. The
 * heartbeat is the only evidence it is alive, so three missed beats is treated
 * as dead and reconnected — otherwise the UI would report a healthy agent that
 * has not sent activity for an hour.
 */
export function isNativeAgentStale(now = Date.now()): boolean {
  if (!port || !isNativeAgentTracking()) return false;
  if (lastHeartbeatAt === 0) return false;
  return now - lastHeartbeatAt > 90_000;
}

/** Re-establish a stale connection. Called by the manager's alarm tick. */
export function recoverNativeAgentIfStale(): void {
  if (!isNativeAgentStale()) return;
  console.warn('[NativeAgent] no heartbeat in 90s — reconnecting');
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
    port = null;
  }
  setState({ status: 'disconnected', error: 'The agent stopped responding.' });
  scheduleReconnect();
}
