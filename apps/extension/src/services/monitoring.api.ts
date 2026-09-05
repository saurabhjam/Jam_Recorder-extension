/**
 * Screen monitoring — API client.
 *
 * Plain `fetch` rather than the shared axios instance: every call here is made
 * from the background service worker, often from an alarm handler in a worker
 * that woke up seconds ago, and axios's interceptor chain adds a dependency on
 * module state that a freshly-woken worker may not have hydrated yet. Tokens
 * are read from storage per request, which is also what makes a retry after a
 * refresh Just Work.
 */

import { STORAGE_KEYS } from '@/types';
import { MONITORING_STORAGE_KEYS } from '@/types/monitoring';
import type { AuthTokens } from '@/types';
import type {
  ActivityBatchResponse,
  DailyMonitoringReportResource,
  MonitoringActivityPayload,
  MonitoringInterval,
  SnapshotUploadResponse,
  StartMonitoringResponse,
} from '@/types/monitoring';
import { API_BASE_URL } from '@/config';

/**
 * An API failure that preserves the backend's stable monitoring error code.
 *
 * The code is what callers branch on — `MONITORING_ALREADY_ACTIVE` means
 * "re-read state", `MONITORING_SESSION_NOT_ACTIVE` means "our session is gone,
 * stop pretending otherwise" — so it must survive the trip out of here rather
 * than being flattened into a message string.
 */
export class MonitoringApiError extends Error {
  readonly code: string | null;

  readonly status: number;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'MonitoringApiError';
    this.status = status;
    this.code = code;
  }

  /** True for failures a retry could plausibly fix (network, 5xx, throttling). */
  get isRetryable(): boolean {
    if (this.status === 0) return true; // network unreachable
    if (this.status === 429) return true;
    return this.status >= 500;
  }
}

/** Pull the stable `MONITORING_*` token out of an error body. */
function extractCode(body: unknown): string | null {
  const text =
    typeof body === 'string'
      ? body
      : [(body as { message?: string })?.message, (body as { errorCode?: string })?.errorCode]
          .filter(Boolean)
          .join(' ');
  const match = /\b(MONITORING_[A-Z_]+)\b/.exec(text);
  return match ? match[1] : null;
}

async function getAccessToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
  const tokens = stored[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;
  return tokens?.accessToken ?? null;
}

/**
 * The project monitoring writes to.
 *
 * Read from monitoring's own key, NOT the shared `st_auth_project`: the
 * recording upload path writes a hardcoded `superadmin_personal` fallback into
 * that shared key, which silently reassigned live monitoring sessions to a
 * project the user is not even a member of.
 */
export async function getMonitoringProject(): Promise<string | null> {
  const stored = await chrome.storage.local.get([MONITORING_STORAGE_KEYS.PROJECT]);
  const project = stored[MONITORING_STORAGE_KEYS.PROJECT] as string | undefined;
  return project ?? null;
}

/** Remember the project for this and future monitoring sessions. */
export async function setMonitoringProject(project: string): Promise<void> {
  await chrome.storage.local.set({ [MONITORING_STORAGE_KEYS.PROJECT]: project });
}

async function request<T>(project: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/${project}/monitoring${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    // Status 0 marks "never reached the server", which is retryable in a way a
    // 400 is not — the caller queues instead of discarding.
    throw new MonitoringApiError(err instanceof Error ? err.message : 'Network error', 0, null);
  }

  if (response.status === 204) return undefined as T;

  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  if (!response.ok) {
    const message =
      (body as { message?: string })?.message ?? `Request failed (${response.status})`;
    throw new MonitoringApiError(message, response.status, extractCode(body));
  }

  return body as T;
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Begin (or re-attach to) a monitoring session.
 *
 * Idempotent on `clientSessionId`: sending the same id twice returns the same
 * session rather than opening a second one. That is what makes a double-clicked
 * Start button, a retry after a timeout, and a service-worker restart mid-start
 * all safe — as long as the caller reuses the id, which is why it is persisted
 * before the first attempt rather than generated per call.
 */
export function startMonitoring(
  project: string,
  clientSessionId: string,
  intervalSeconds: MonitoringInterval,
  startedAt: string,
): Promise<StartMonitoringResponse> {
  return request<StartMonitoringResponse>(project, '/start', {
    method: 'POST',
    body: JSON.stringify({ clientSessionId, intervalSeconds, startedAt }),
  });
}

/**
 * Tell the server the client process is still alive.
 *
 * Explicitly NOT evidence that the user is active: a heartbeat proves only that
 * the extension is running. Inactivity is reported separately, from real OS
 * idleness. Missing heartbeats expire the session; they never become an
 * inactive period.
 */
export function sendHeartbeat(
  project: string,
  sessionId: string,
  payload: { clientTime: string; lastActivityAt?: string; lastSnapshotAt?: string },
): Promise<void> {
  return request<void>(project, `/sessions/${sessionId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function pauseMonitoring(project: string, sessionId: string, at: string): Promise<void> {
  return request<void>(project, `/sessions/${sessionId}/pause`, {
    method: 'POST',
    body: JSON.stringify({ at }),
  });
}

export function resumeMonitoring(project: string, sessionId: string, at: string): Promise<void> {
  return request<void>(project, `/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ at }),
  });
}

/** Stop and settle the day. Stopping an already-stopped session is a no-op. */
export function stopMonitoring(
  project: string,
  sessionId: string,
  endedAt: string,
): Promise<DailyMonitoringReportResource> {
  return request<DailyMonitoringReportResource>(project, `/sessions/${sessionId}/stop`, {
    method: 'POST',
    body: JSON.stringify({ endedAt }),
  });
}

// ─── Inactivity ───────────────────────────────────────────────────────────────

/**
 * Open an inactive period.
 *
 * `startedAt` is when the user actually went idle — not when we noticed. The
 * threshold decides whether a stretch qualifies; its real extent is what gets
 * stored, so the report can say "22 min" instead of the threshold.
 */
export function startInactivity(
  project: string,
  sessionId: string,
  startedAt: string,
): Promise<{ id: string } | undefined> {
  return request<{ id: string } | undefined>(project, `/sessions/${sessionId}/inactivity/start`, {
    method: 'POST',
    body: JSON.stringify({ startedAt }),
  });
}

/** Close it. A stretch that ends below the threshold is discarded server-side. */
export function endInactivity(project: string, sessionId: string, endedAt: string): Promise<void> {
  return request<void>(project, `/sessions/${sessionId}/inactivity/end`, {
    method: 'POST',
    body: JSON.stringify({ endedAt }),
  });
}

// ─── Activity ─────────────────────────────────────────────────────────────────

/**
 * Flush observed activity.
 *
 * Batched because one request per tab switch would be an order of magnitude
 * more traffic for the same data. Partial acceptance is the contract: one bad
 * interval in a batch of 200 does not cost the other 199, and re-sending a
 * batch comes back as `duplicates`, which is how a retry confirms the first
 * attempt landed.
 */
export function sendActivityBatch(
  project: string,
  sessionId: string,
  activities: MonitoringActivityPayload[],
): Promise<ActivityBatchResponse> {
  return request<ActivityBatchResponse>(project, `/sessions/${sessionId}/activities/batch`, {
    method: 'POST',
    body: JSON.stringify({ activities }),
  });
}

// ─── Screenshots ──────────────────────────────────────────────────────────────

/**
 * Ask for a signed URL to PUT one capture to.
 *
 * Note what cannot be sent: a storage key. The server derives it from the
 * session's own project, user, date and id, because a key the client chooses is
 * a destination the client chooses.
 */
export function requestSnapshotUpload(
  project: string,
  sessionId: string,
  payload: {
    clientSnapshotId: string;
    capturedAt: string;
    mimeType: string;
    fileSize: number;
  },
): Promise<SnapshotUploadResponse> {
  return request<SnapshotUploadResponse>(project, `/sessions/${sessionId}/snapshots/upload-url`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * PUT the bytes straight to object storage.
 *
 * Deliberately not routed through the API: at 20 users on a 30-second interval
 * that is ~19,200 images a day, and streaming each through the application tier
 * would spend its bandwidth and heap on bytes it has no reason to touch.
 */
export async function uploadSnapshotBytes(
  uploadUrl: string,
  blob: Blob,
  mimeType: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: blob,
    });
  } catch (err) {
    throw new MonitoringApiError(
      err instanceof Error ? err.message : 'Upload failed',
      0,
      'MONITORING_UPLOAD_FAILED',
    );
  }
  if (!response.ok) {
    throw new MonitoringApiError(
      `Snapshot upload failed (${response.status})`,
      response.status,
      'MONITORING_UPLOAD_FAILED',
    );
  }
}

/**
 * Send the bytes through the API instead of straight to storage.
 *
 * Used when the grant comes back as `PROXY`, which is what a deployment whose
 * object storage has no public HTTPS address must do. It costs the application
 * the bandwidth the direct path was designed to avoid, but a signed URL over an
 * in-cluster host is not a cheaper upload — it is no upload at all: the browser
 * refuses it as mixed content and as a private-network request, and every
 * screenshot piles up in the retry queue.
 *
 * The destination is the reservation the server already made for this
 * `clientSnapshotId`. No storage key is sent, for the same reason none is sent
 * when asking for the grant.
 */
export function uploadSnapshotBytesViaApi(
  project: string,
  sessionId: string,
  clientSnapshotId: string,
  blob: Blob,
  mimeType: string,
): Promise<void> {
  return request<void>(
    project,
    `/sessions/${sessionId}/snapshots/${encodeURIComponent(clientSnapshotId)}/content`,
    { method: 'POST', body: blob, headers: { 'Content-Type': mimeType } },
  );
}

/**
 * Confirm the object landed.
 *
 * The server stats the object before accepting, replacing whatever size and
 * content type the request claimed with the real ones — so a snapshot whose
 * bytes never arrived stays PENDING instead of appearing in a gallery as a
 * broken image.
 */
export function completeSnapshot(
  project: string,
  sessionId: string,
  payload: {
    clientSnapshotId: string;
    storageKey: string;
    capturedAt: string;
    pageUrl?: string;
    pageTitle?: string;
    domain?: string;
    viewportWidth?: number;
    viewportHeight?: number;
  },
): Promise<void> {
  return request<void>(project, `/sessions/${sessionId}/snapshots/complete`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ─── Reads (for the popup's own summary) ──────────────────────────────────────

export function fetchOwnDailyReport(
  project: string,
  date?: string,
): Promise<DailyMonitoringReportResource> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return request<DailyMonitoringReportResource>(project, `/daily${query}`, { method: 'GET' });
}
