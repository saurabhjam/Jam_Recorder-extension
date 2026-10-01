/**
 * What the toolbar icon is allowed to say, as a pure function of the truth.
 *
 * ── The promise this file exists to keep ─────────────────────────────────────
 * MON means one thing: monitoring is running on this machine right now AND
 * screenshots are actually arriving. It is the only thing most people ever look
 * at, so it must never outlive the session it describes — not through a stop, a
 * sleep, a shutdown, a lost network, a dead agent, a crashed worker or an
 * expiry decided by the server. Anything less certain gets a different badge,
 * never a reassuring one.
 *
 * Keeping the decision here, with no chrome.* and no module state, is what lets
 * every one of those cases be a test rather than a thing someone noticed on
 * their own toolbar a day later.
 */

/**
 * The three state machines this reads, spelled out rather than imported.
 *
 * Like the other policy modules here, this one is compiled on its own by the
 * test runner, so it stays free of path aliases and of anything that reaches
 * into chrome.*. The members mirror types/monitoring.ts and a value from there
 * assigns straight into these.
 */
type MonitoringStatus = 'idle' | 'starting' | 'monitoring' | 'paused' | 'stopping' | 'error';
type CaptureStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'capturing'
  | 'reconnect'
  | 'failed'
  | 'stopped';
type NativeAgentStatus =
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

export const BADGE = {
  /** Monitoring, and frames are landing. */
  ACTIVE: { text: 'MON', color: '#00829b' },
  /** Deliberately paused by the person. */
  PAUSED: { text: '❚❚', color: '#7a6cc4' },
  /** A session is open but nothing is being captured — the honest warning. */
  STALLED: { text: '!', color: '#d78706' },
  /** No badge at all. */
  NONE: { text: '', color: null },
} as const;

export type BadgeView = { text: string; color: string | null };

/**
 * How long without a frame before a session counts as not capturing.
 *
 * Two intervals plus a minute: one missed capture is ordinary — a slow encode,
 * a machine under load — and two in a row is not.
 */
export function captureGraceMs(intervalSeconds: number): number {
  return intervalSeconds * 2_000 + 60_000;
}

export interface BadgeInput {
  status: MonitoringStatus;
  captureStatus: CaptureStatus;
  agentStatus: NativeAgentStatus;
  /** When a frame was last stored, from the capture health record. */
  lastCaptureAtMs: number | null;
  intervalSeconds: number;
  nowMs: number;
  /** A screen recording is showing REC; monitoring must not fight it for the badge. */
  recordingOwnsBadge: boolean;
}

/**
 * The badge for this state, or null to mean "leave the badge alone" — the one
 * case being a recording that owns it.
 */
export function badgeFor(input: BadgeInput): BadgeView | null {
  if (input.recordingOwnsBadge) return null;

  switch (input.status) {
    // Nothing is running. This includes 'stopping': from the moment a stop
    // begins, nothing more is captured, and the badge should go at once rather
    // than linger for the seconds the stop spends talking to the server.
    case 'idle':
    case 'stopping':
    case 'error':
      return BADGE.NONE;

    case 'paused':
      return BADGE.PAUSED;

    // Asked for, not yet proven. The badge waits for the first frame rather
    // than promising on the strength of a request that may still fail.
    case 'starting':
      return BADGE.NONE;

    case 'monitoring':
      return capturing(input) ? BADGE.ACTIVE : BADGE.STALLED;

    default:
      return BADGE.NONE;
  }
}

/** Is this session actually producing screenshots at this moment? */
function capturing(input: BadgeInput): boolean {
  if (input.captureStatus === 'failed' || input.captureStatus === 'reconnect') return false;
  if (input.captureStatus === 'stopped') return false;
  if (
    input.agentStatus === 'disconnected' ||
    input.agentStatus === 'unavailable' ||
    input.agentStatus === 'permission-required' ||
    input.agentStatus === 'unsupported-platform' ||
    input.agentStatus === 'outdated' ||
    input.agentStatus === 'error'
  ) {
    return false;
  }
  // Nothing captured yet: true only for as long as the first frame could still
  // be on its way.
  if (input.lastCaptureAtMs == null) return false;
  return input.nowMs - input.lastCaptureAtMs <= captureGraceMs(input.intervalSeconds);
}

/** Did the badge change? Used to keep chrome.action calls down to real changes. */
export function sameBadge(a: BadgeView | null, b: BadgeView | null): boolean {
  if (a == null || b == null) return a === b;
  return a.text === b.text && a.color === b.color;
}
