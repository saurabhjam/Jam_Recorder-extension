import { config } from '../config';

// ─── Payload Types ────────────────────────────────────────────────────────────

export interface RecordPayload {
  id: string;
  title: string;
  description: string;
  userId: string;
  projectId: string;
  status: string;
  type: string;
  url: string;
  thumbnailUrl: string;
  duration: number;
  size: number;
  mimeType: string;
  shareId: string;
  isPublic: boolean;
  allowDownload: boolean;
  viewCount: number;
  metadata: string;
  createdAt: string;
  updatedAt: string;
  consoleLogs: string;
  networkLogs: string;
}

// ─── ExternalApiClient ────────────────────────────────────────────────────────

export class ExternalApiClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly projectId: string;

  // In-memory token state (survives the process lifetime — refreshed on demand)
  private accessToken: string;
  private tokenExpiresAt: number; // Unix ms

  constructor() {
    this.baseUrl = config.externalApi.baseUrl;
    this.username = config.externalApi.username;
    this.password = config.externalApi.password;
    this.projectId = config.externalApi.projectId;
    this.accessToken = config.externalApi.token;
    this.tokenExpiresAt = this.parseExpiry(this.accessToken);
  }

  // ─── JWT expiry helper ─────────────────────────────────────────────────────

  private parseExpiry(token: string): number {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
      return (payload.exp as number) * 1000; // convert to ms
    } catch {
      return 0; // treat as already expired
    }
  }

  private isTokenExpired(): boolean {
    // Refresh 60 seconds before actual expiry to avoid race conditions
    return Date.now() >= this.tokenExpiresAt - 60_000;
  }

  // ─── Auto-login ────────────────────────────────────────────────────────────

  private async refreshToken(): Promise<void> {
    console.log('[ExternalAPI] Token expired — fetching new JWT via password grant');

    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.username,
      password: this.password,
    });

    const res = await fetch(`${this.baseUrl}/uat/sso/oauth/token`, {
      method: 'POST',
      headers: {
        // Basic auth: base64("ui:uiman") — required by the ReportPortal OAuth server
        Authorization: 'Basic dWk6dWltYW4=',
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      token_type?: string;
    };

    this.accessToken = data.access_token;
    this.tokenExpiresAt = this.parseExpiry(this.accessToken);
    console.log(
      `[ExternalAPI] Token refreshed — expires at ${new Date(this.tokenExpiresAt).toISOString()}`,
    );
  }

  // ─── Ensure valid token before every request ───────────────────────────────

  private async ensureToken(): Promise<void> {
    if (this.isTokenExpired()) {
      await this.refreshToken();
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json, text/plain, */*',
    };
  }

  // ─── Retry once on 401 (token may have expired between check and request) ──

  private async fetchWithRetry(url: string, init: RequestInit, retried = false): Promise<Response> {
    const res = await fetch(url, init);
    if (res.status === 401 && !retried) {
      await this.refreshToken();
      const retryInit = {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          Authorization: `Bearer ${this.accessToken}`,
        },
      };
      return this.fetchWithRetry(url, retryInit, true);
    }
    return res;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Upload a video/image file and return its accessible URL.
   * POST /api/v1/superadmin_personal/files/upload
   */
  async uploadFile(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
    await this.ensureToken();

    // Strip codec parameters — RFC 2045 requires plain type/subtype
    const baseMimeType = mimeType.split(';')[0]!.trim();

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: baseMimeType }), filename);

    const res = await this.fetchWithRetry(
      `${this.baseUrl}/api/v1/superadmin_personal/files/upload`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`File upload failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      id?: string;
      fileId?: string;
      filename?: string;
      url?: string;
    };

    if (data.url) return data.url;
    const fileRef = data.id ?? data.fileId ?? data.filename ?? filename;
    return `${this.baseUrl}/api/v1/superadmin_personal/files/${fileRef}`;
  }

  /**
   * Register a completed recording in the external portal.
   * POST /api/v1/superadmin_personal/records
   */
  async createRecord(payload: RecordPayload): Promise<{ id: string; shareUrl: string }> {
    await this.ensureToken();

    const res = await this.fetchWithRetry(`${this.baseUrl}/api/v1/superadmin_personal/records`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Create record failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { id?: string; shareId?: string };
    const recordId = data.id ?? data.shareId ?? payload.id;
    return {
      id: recordId,
      shareUrl: `${this.baseUrl}/ui/#records/${recordId}/all`,
    };
  }
}

export const externalApi = new ExternalApiClient();
