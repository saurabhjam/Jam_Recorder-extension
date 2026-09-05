/**
 * Screen monitoring — activity timeline.
 *
 * ── What was wrong before ────────────────────────────────────────────────────
 * Four separate defects, all of which lost real data:
 *
 *  1. The interval already open when monitoring started was never recorded.
 *     Tracking only reacted to *changes*, so a user who began the session on
 *     Jira and read it for twenty minutes produced nothing at all.
 *  2. The open interval lived in a module variable. An MV3 worker is torn down
 *     constantly, so every teardown silently discarded the time since the last
 *     focus change.
 *  3. Stop never closed the open interval, so the last stretch of every
 *     session — often the longest — was dropped.
 *  4. Only tab activation and `complete` navigations were observed, so
 *     single-page-app route changes (Jira board → Jira issue) collapsed into
 *     one undifferentiated interval.
 *
 * ── Two sources, never conflated ─────────────────────────────────────────────
 * The native agent reports the real OS foreground application. The extension
 * reports pages in its own Chrome profile. When the agent is present it is
 * authoritative for *which application*, and the extension merely enriches a
 * browser interval with the domain and URL it can see. When the agent is
 * absent, intervals are labelled `applicationName: 'Google Chrome'` with the
 * page detail we do have, and nothing claims to know about other applications.
 *
 * Crucially, the extension never enriches an interval belonging to a *different*
 * Chrome profile. `chrome.tabs.query()` cannot see another profile's tabs, so
 * attributing a URL to one would be fabricating it.
 */

import { generateId } from '@/utils';
import {
  ACTIVITY_BATCH_MAX,
  MONITORING_STORAGE_KEYS,
  type MonitoringActivityPayload,
  type NativeActivity,
  type OpenActivity,
} from '@/types/monitoring';

/** Shorter than this and it was a flick-through, not work. */
const MIN_ACTIVITY_MS = 1000;

/** Cap the unsent buffer so an outage cannot grow it without bound. */
const MAX_BUFFERED_ACTIVITIES = 2000;

// ─── Persistence ──────────────────────────────────────────────────────────────

async function readOpenActivity(): Promise<OpenActivity | null> {
  const stored = await chrome.storage.local.get([MONITORING_STORAGE_KEYS.OPEN_ACTIVITY]);
  return (stored[MONITORING_STORAGE_KEYS.OPEN_ACTIVITY] as OpenActivity | undefined) ?? null;
}

async function writeOpenActivity(activity: OpenActivity | null): Promise<void> {
  if (!activity) {
    await chrome.storage.local.remove([MONITORING_STORAGE_KEYS.OPEN_ACTIVITY]);
    return;
  }
  await chrome.storage.local.set({ [MONITORING_STORAGE_KEYS.OPEN_ACTIVITY]: activity });
}

async function readBuffer(): Promise<MonitoringActivityPayload[]> {
  const stored = await chrome.storage.local.get([MONITORING_STORAGE_KEYS.ACTIVITY_BUFFER]);
  return (stored[MONITORING_STORAGE_KEYS.ACTIVITY_BUFFER] as MonitoringActivityPayload[]) ?? [];
}

async function writeBuffer(buffer: MonitoringActivityPayload[]): Promise<void> {
  const bounded =
    buffer.length > MAX_BUFFERED_ACTIVITIES ? buffer.slice(-MAX_BUFFERED_ACTIVITIES) : buffer;
  await chrome.storage.local.set({ [MONITORING_STORAGE_KEYS.ACTIVITY_BUFFER]: bounded });
}

// ─── Identity ─────────────────────────────────────────────────────────────────

/**
 * A stable key for "the same thing is still in front".
 *
 * An interval is closed only when this changes. Without it, every unrelated
 * event that fires while the user sits on one page (a title tweak, a focus
 * blip, a background tab finishing a load) would close and reopen the interval,
 * producing hundreds of fragments that sum correctly but describe nothing.
 */
function identityFor(parts: {
  applicationName?: string;
  profileName?: string;
  domain?: string;
  url?: string;
  pageTitle?: string;
}): string {
  return [
    parts.applicationName ?? '',
    parts.profileName ?? '',
    parts.domain ?? '',
    // The URL without its query/fragment: a tracking parameter changing is not
    // the user navigating, but a real path change is.
    stripUrlNoise(parts.url),
    parts.pageTitle ?? '',
  ].join('|');
}

/** Path-level URL identity; query and fragment are dropped. */
function stripUrlNoise(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Domain, or null for anything that is not an addressable web page. */
export function toDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

// ─── Interval lifecycle ───────────────────────────────────────────────────────

/**
 * Close the open interval at `at` and buffer it.
 *
 * Returns the closed payload, or null when there was nothing open or the
 * interval was too short to mean anything.
 */
export async function closeOpenActivity(
  at = new Date(),
): Promise<MonitoringActivityPayload | null> {
  const open = await readOpenActivity();
  if (!open) return null;
  await writeOpenActivity(null);

  const startedMs = new Date(open.startedAt).getTime();
  const durationMs = at.getTime() - startedMs;
  if (!Number.isFinite(startedMs) || durationMs < MIN_ACTIVITY_MS) return null;

  const payload: MonitoringActivityPayload = {
    clientActivityId: generateId(18),
    activityType: open.activityType,
    // This row describes a page in the extension's OWN Chrome profile. It is
    // not evidence about which application had OS focus, and the source field
    // is what stops a report from reading it that way.
    source: 'EXTENSION',
    applicationName: open.applicationName,
    domain: open.domain,
    url: open.url,
    pageTitle: open.pageTitle,
    startedAt: open.startedAt,
    endedAt: at.toISOString(),
  };

  const buffer = await readBuffer();
  buffer.push(payload);
  await writeBuffer(buffer);
  return payload;
}

/**
 * Open a new interval, closing whatever preceded it.
 *
 * A no-op when the identity has not changed — that check is what keeps one long
 * stretch of reading as one row.
 */
async function openActivity(
  next: Omit<OpenActivity, 'identity' | 'startedAt'>,
  at = new Date(),
): Promise<void> {
  const identity = identityFor(next);
  const current = await readOpenActivity();
  if (current && current.identity === identity) return;

  await closeOpenActivity(at);
  await writeOpenActivity({ ...next, identity, startedAt: at.toISOString() });
}

// ─── Extension-side (this Chrome profile) ─────────────────────────────────────

/**
 * Record the page in front, from a tab this profile owns.
 *
 * Skipped entirely while the native agent is tracking AND the browser is not
 * frontmost: the agent already owns the timeline in that case, and adding a
 * browser interval for a browser nobody is looking at would double-count time.
 */
export async function noteActivePage(
  tab: chrome.tabs.Tab | undefined,
  options: { nativeTracking: boolean; browserInForeground: boolean },
): Promise<void> {
  const domain = toDomain(tab?.url);
  if (!domain) {
    // A non-web page (new tab, settings, an extension page). Nothing truthful
    // to record, and closing the open interval here would attribute the time to
    // nobody — so leave the current interval running.
    return;
  }

  // With the agent present, the browser's own page changes still matter — they
  // are what turn "Google Chrome, 2h" into per-site rows — but only while the
  // browser is actually in front.
  if (options.nativeTracking && !options.browserInForeground) return;

  await openActivity({
    source: 'extension',
    // PAGE, not WEBSITE: this is one specific page in one specific tab. The
    // backend aggregates pages into per-domain website totals itself.
    activityType: 'PAGE',
    applicationName: 'Google Chrome',
    domain,
    url: tab?.url,
    pageTitle: tab?.title,
  });
}

/**
 * Record the interval already in progress when monitoring starts.
 *
 * Without this the page the user was already on — very often where they spend
 * the first stretch of the session — is never recorded at all.
 */
export async function initializeCurrentActivity(options: {
  nativeTracking: boolean;
}): Promise<void> {
  try {
    // The focused window's active tab, not `currentWindow` — a service worker
    // has no current window, and that call resolves to something arbitrary.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    await noteActivePage(tab, {
      nativeTracking: options.nativeTracking,
      // At session start the user just clicked Start in the popup, so the
      // browser genuinely is in front.
      browserInForeground: true,
    });
  } catch {
    /* no window available; the first real event will open an interval */
  }
}

// ─── Native-side (the whole machine) ──────────────────────────────────────────

/**
 * Buffer a closed focus interval from the native agent.
 *
 * These arrive already closed — the agent knows the true boundaries — so they
 * are buffered directly rather than going through open/close.
 *
 * Recorded as APPLICATION with source NATIVE_AGENT. That pairing is the whole
 * reconciliation rule: the agent is authoritative for *which application* was
 * frontmost (including a browser belonging to a Chrome profile this extension
 * cannot see), while the extension's own PAGE rows carry URL-level detail for
 * its own profile only. Two sources, two kinds of claim, never merged into one
 * row that overstates what either knew.
 *
 * The agent's own `clientActivityId` is preserved rather than regenerated: it is
 * what makes a resend after a reconnect idempotent at the backend.
 */
export async function recordNativeInterval(interval: NativeActivity): Promise<void> {
  if (interval.durationSeconds * 1000 < MIN_ACTIVITY_MS) return;

  const payload: MonitoringActivityPayload = {
    clientActivityId: interval.clientActivityId,
    activityType: 'APPLICATION',
    source: 'NATIVE_AGENT',
    applicationName: interval.applicationName,
    applicationId: interval.applicationId,
    processId: interval.processId,
    browserName: interval.browserName,
    browserProfile: interval.browserProfile,
    windowTitle: interval.titleSuppressed ? undefined : interval.windowTitle,
    // No `domain`, `url` or `pageTitle`. The agent read a window title, not a
    // URL — and for another Chrome profile there is genuinely no way to know
    // one. Populating any of these from a title would be fabricating a visit.
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
  };

  const buffer = await readBuffer();
  buffer.push(payload);
  await writeBuffer(buffer);
}

// ─── Flush ────────────────────────────────────────────────────────────────────

/**
 * Send buffered intervals.
 *
 * `sendBatch` is injected so this module stays free of API and session
 * concerns. Partial acceptance is the contract: a batch that the server refuses
 * outright is dropped rather than retried forever, because one malformed row
 * must not block every row behind it — but a batch that never reached the
 * server is kept.
 */
export async function flushActivityBuffer(
  // Returns `unknown` rather than `void`: the API's batch response is genuinely
  // useful to a caller that wants it, and forcing every call site to discard it
  // would mean wrapping the sender just to satisfy a signature.
  sendBatch: (activities: MonitoringActivityPayload[]) => Promise<unknown>,
  isRetryable: (err: unknown) => boolean,
): Promise<void> {
  const buffer = await readBuffer();
  if (buffer.length === 0) return;

  const batch = buffer.slice(0, ACTIVITY_BATCH_MAX);
  try {
    await sendBatch(batch);
    const remaining = (await readBuffer()).slice(batch.length);
    await writeBuffer(remaining);
  } catch (err) {
    if (!isRetryable(err)) {
      console.warn('[Monitoring] activity batch rejected, dropping it');
      const remaining = (await readBuffer()).slice(batch.length);
      await writeBuffer(remaining);
      return;
    }
    // Retryable — leave it for the next tick.
  }
}

/** Drop everything buffered. Used once a session is fully settled. */
export async function clearActivityState(): Promise<void> {
  await chrome.storage.local.remove([
    MONITORING_STORAGE_KEYS.ACTIVITY_BUFFER,
    MONITORING_STORAGE_KEYS.OPEN_ACTIVITY,
  ]);
}

export async function bufferedActivityCount(): Promise<number> {
  return (await readBuffer()).length;
}

/** A short human label for what is in front, for the popup. */
export async function currentActivityLabel(): Promise<string | null> {
  const open = await readOpenActivity();
  if (!open) return null;
  return open.domain ?? open.applicationName ?? null;
}
