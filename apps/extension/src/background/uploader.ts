/**
 * ChunkUploader — used by the popup's recordingsApi when needed outside the
 * offscreen context (e.g. uploading screenshots captured via tabs.captureVisibleTab
 * in tests or manual flows).
 *
 * Upload protocol matching backend:
 *   1. POST /files/upload → single multipart request, returns the MinIO filename
 *   2. POST /records      → create the record referencing that filename
 *
 * `/uploads/initiate` (chunked-session upload) 404s on any id the backend
 * hasn't seen before and there's no confirmed contract for pre-registering
 * one, so this deliberately uploads in a single request rather than chunked.
 */

import type { RecordingMetadata, UploadProgress, AuthTokens } from '@/types';
import { STORAGE_KEYS } from '@/types';
import { generateId, retryWithBackoff, sleep } from '@/utils';
import { buildShareUrl, API_BASE_URL } from '@/config';

async function getProject(token: string): Promise<string> {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_PROJECT]);
    const cached = stored[STORAGE_KEYS.AUTH_PROJECT] as string | undefined;
    if (cached) return cached;

    const res = await fetch(`${API_BASE_URL}/users?ids=`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const raw = (await res.json()) as
        | { assignedProjects?: Record<string, unknown> }
        | Array<{ assignedProjects?: Record<string, unknown> }>;
      const projects = Array.isArray(raw) ? raw[0]?.assignedProjects : raw?.assignedProjects;
      const name = Object.keys(projects ?? {})[0];
      if (name) {
        await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_PROJECT]: name });
        return name;
      }
    }
  } catch {
    /* fall through */
  }
  return 'superadmin_personal';
}

// ─── Offline Queue Types ──────────────────────────────────────────────────────

interface QueuedUpload {
  id: string;
  blobBase64: string;
  metadata: RecordingMetadata;
  timestamp: number;
}

// ─── ChunkUploader ────────────────────────────────────────────────────────────

export class ChunkUploader {
  async upload(
    blob: Blob,
    metadata: RecordingMetadata,
    onProgress: (progress: UploadProgress) => void,
  ): Promise<string> {
    const token = await this.getAccessToken();
    if (!token) throw new Error('Not authenticated — cannot upload');

    const totalBytes = blob.size;
    const project = await getProject(token);
    const ts = Date.now();
    const isoNow = new Date(ts).toISOString();

    // Phase 1: upload file → get MinIO filename
    const ext = metadata.mimeType.startsWith('image/') ? 'png' : 'webm';
    let fileName: string;
    let recordingId = '';
    try {
      fileName = await retryWithBackoff(async () => {
        const file = new File([blob], `${metadata.type ?? 'recording'}-${ts}.${ext}`, {
          type: metadata.mimeType.split(';')[0],
        });
        const formData = new FormData();
        formData.append('file', file);

        return await new Promise<string>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${API_BASE_URL}/v1/${project}/files/upload`);
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.setRequestHeader('Accept', 'text/plain, application/json, */*');
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              onProgress({
                recordingId: '',
                totalChunks: 1,
                uploadedChunks: 0,
                totalBytes,
                uploadedBytes: e.loaded,
                speed: 0,
                percentComplete: Math.round((e.loaded / e.total) * 85),
                eta: 0,
              });
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText.trim());
            else reject(new Error(`File upload failed: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('Network error during file upload'));
          xhr.send(formData);
        });
      }, 3);
    } catch (err) {
      await this.saveToOfflineQueue(blob, metadata);
      throw new Error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Phase 2: create record with all required fields
    const fileUrl = `${API_BASE_URL}/v1/${project}/files/${fileName}`;
    try {
      const userId = await this.getUserId();
      const createRes = await fetch(`${API_BASE_URL}/v1/${project}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeader(token) },
        body: JSON.stringify({
          title: metadata.title,
          description:
            metadata.description?.trim().slice(0, 125) || 'Recording captured with BestQ',
          type: 'video',
          mimeType: metadata.mimeType.split(';')[0],
          status: 'completed',
          userId,
          projectId: '1',
          shareId: `share-${ts}`,
          isPublic: false,
          allowDownload: true,
          viewCount: 0,
          url: fileUrl,
          size: totalBytes,
          duration: Math.round(metadata.duration ?? 0),
          metadata: JSON.stringify({
            browser: 'chrome',
            source: (metadata.type ?? 'tab').toLowerCase(),
          }),
          createdAt: isoNow,
          updatedAt: isoNow,
        }),
      });
      if (!createRes.ok) {
        const e = (await createRes.json().catch(() => ({}))) as { message?: string };
        throw new Error(e.message ?? `Create record failed: ${createRes.status}`);
      }
      const created = (await createRes.json()) as { id: string };
      recordingId = created.id;
    } catch (err) {
      throw new Error(`Create record failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const shareUrl = buildShareUrl(project, recordingId);

    onProgress({
      recordingId,
      totalChunks: 1,
      uploadedChunks: 1,
      totalBytes,
      uploadedBytes: totalBytes,
      speed: 0,
      percentComplete: 100,
      eta: 0,
    });

    return shareUrl;
  }

  // ─── Offline Queue ─────────────────────────────────────────────────────────

  async processOfflineQueue(
    onProgress: (progress: UploadProgress) => void,
    onComplete: (id: string, shareUrl: string) => void,
  ): Promise<void> {
    const result = await chrome.storage.local.get([STORAGE_KEYS.OFFLINE_QUEUE]);
    const queue = (result[STORAGE_KEYS.OFFLINE_QUEUE] as QueuedUpload[]) ?? [];
    if (queue.length === 0) return;

    const succeeded: string[] = [];

    for (const item of queue) {
      try {
        const blob = this.base64ToBlob(item.blobBase64, item.metadata.mimeType);
        const shareUrl = await this.upload(blob, item.metadata, onProgress);
        onComplete(item.id, shareUrl);
        succeeded.push(item.id);
        await sleep(500);
      } catch (err) {
        console.error(`[ChunkUploader] Queued item ${item.id} failed:`, err);
      }
    }

    const remaining = queue.filter((q) => !succeeded.includes(q.id));
    await chrome.storage.local.set({ [STORAGE_KEYS.OFFLINE_QUEUE]: remaining });
  }

  // ─── Private HTTP Helpers ──────────────────────────────────────────────────

  private async getAccessToken(): Promise<string | null> {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
      const tokens = result[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;
      return tokens?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  private async getUserId(): Promise<string | null> {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH_USER]);
      const user = result[STORAGE_KEYS.AUTH_USER] as { id?: string } | undefined;
      return user?.id ?? null;
    } catch {
      return null;
    }
  }

  private authHeader(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  async saveToOfflineQueue(blob: Blob, metadata: RecordingMetadata): Promise<void> {
    try {
      const base64 = await this.blobToBase64(blob);
      const item: QueuedUpload = {
        id: generateId(12),
        blobBase64: base64,
        metadata,
        timestamp: Date.now(),
      };
      const result = await chrome.storage.local.get([STORAGE_KEYS.OFFLINE_QUEUE]);
      const queue = (result[STORAGE_KEYS.OFFLINE_QUEUE] as QueuedUpload[]) ?? [];
      await chrome.storage.local.set({
        [STORAGE_KEYS.OFFLINE_QUEUE]: [item, ...queue].slice(0, 5),
      });
    } catch (err) {
      console.error('[ChunkUploader] Failed to save offline queue:', err);
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private base64ToBlob(base64: string, mimeType: string): Blob {
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new Blob([arr], { type: mimeType });
  }
}
