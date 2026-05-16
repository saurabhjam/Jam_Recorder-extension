/**
 * ChunkUploader — used by the popup's recordingsApi when needed outside the
 * offscreen context (e.g. uploading screenshots captured via tabs.captureVisibleTab
 * in tests or manual flows).
 *
 * Upload protocol matching backend:
 *   1. POST /recordings          → create recording row, get recordingId
 *   2. POST /uploads/initiate    → open upload session
 *   3. POST /uploads/chunk?...   → multipart per chunk
 *   4. POST /uploads/complete/:id → finalize
 *
 * Recording type must be uppercase for the backend Zod schema.
 */

import type { RecordingMetadata, UploadProgress, AuthTokens } from '@/types';
import { STORAGE_KEYS, toBackendRecordingType } from '@/types';
import { generateId, retryWithBackoff, sleep } from '@/utils';

// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE_URL: string = (() => {
  try {
    const env = (import.meta as { env?: Record<string, string> }).env;
    return env?.['VITE_API_BASE_URL'] ?? 'http://localhost:3000/api';
  } catch {
    return 'http://localhost:3000/api';
  }
})();

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB

// ─── Offline Queue Types ──────────────────────────────────────────────────────

interface QueuedUpload {
  id: string;
  blobBase64: string;
  metadata: RecordingMetadata;
  timestamp: number;
}

// ─── ChunkUploader ────────────────────────────────────────────────────────────

export class ChunkUploader {
  private cancelled = false;

  async upload(
    blob: Blob,
    metadata: RecordingMetadata,
    onProgress: (progress: UploadProgress) => void,
  ): Promise<string> {
    this.cancelled = false;

    const token = await this.getAccessToken();
    if (!token) throw new Error('Not authenticated — cannot upload');

    const chunks = this.splitBlob(blob);
    const totalChunks = chunks.length;
    const totalBytes = blob.size;

    // Phase 1: create recording + open upload session
    let recordingId: string;
    try {
      recordingId = await retryWithBackoff(
        () => this.createAndInitiate(token, metadata, totalChunks),
        3,
      );
    } catch (err) {
      await this.saveToOfflineQueue(blob, metadata);
      throw new Error(`Upload init failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let uploadedBytes = 0;
    let uploadedChunks = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    // Phase 2: upload chunks
    for (let i = 0; i < chunks.length; i++) {
      if (this.cancelled) {
        await this.abortUpload(token, recordingId);
        throw new Error('Upload cancelled');
      }

      const chunk = chunks[i]!;

      await retryWithBackoff(
        () =>
          this.uploadChunk(token, recordingId, i, totalChunks, chunk, (pct) => {
            const approxBytes = uploadedBytes + (pct / 100) * chunk.size;
            const now = Date.now();
            const timeDiff = (now - lastTime) / 1000;
            let speed = 0;
            if (timeDiff > 0.5) {
              speed = (approxBytes - lastBytes) / timeDiff;
              lastTime = now;
              lastBytes = approxBytes;
            }
            const eta = speed > 0 ? Math.ceil((totalBytes - approxBytes) / speed) : 0;
            onProgress({
              recordingId,
              totalChunks,
              uploadedChunks: i,
              totalBytes,
              uploadedBytes: Math.round(approxBytes),
              speed: Math.round(speed),
              percentComplete: Math.round((approxBytes / totalBytes) * 100),
              eta,
            });
          }),
        3,
      );

      uploadedBytes += chunk.size;
      uploadedChunks = i + 1;

      onProgress({
        recordingId,
        totalChunks,
        uploadedChunks,
        totalBytes,
        uploadedBytes,
        speed: 0,
        percentComplete: Math.round((uploadedBytes / totalBytes) * 100),
        eta: 0,
      });
    }

    // Phase 3: finalize
    const shareUrl = await retryWithBackoff(() => this.finalizeUpload(token, recordingId), 3);

    onProgress({
      recordingId,
      totalChunks,
      uploadedChunks: totalChunks,
      totalBytes,
      uploadedBytes: totalBytes,
      speed: 0,
      percentComplete: 100,
      eta: 0,
    });

    return shareUrl;
  }

  cancel(): void {
    this.cancelled = true;
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

  private authHeader(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  private async createAndInitiate(
    token: string,
    metadata: RecordingMetadata,
    totalChunks: number,
  ): Promise<string> {
    // Create recording row
    const createRes = await fetch(`${API_BASE_URL}/recordings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader(token) },
      body: JSON.stringify({
        title: metadata.title,
        type: toBackendRecordingType(metadata.type),
        totalChunks,
        mimeType: metadata.mimeType,
      }),
    });
    if (!createRes.ok) {
      const err = (await createRes.json().catch(() => ({}))) as { message?: string };
      throw new Error(err.message ?? `Create recording failed: ${createRes.status}`);
    }
    const createData = (await createRes.json()) as { data: { id: string } };
    const recordingId = createData.data.id;

    // Open upload session
    const initiateRes = await fetch(`${API_BASE_URL}/uploads/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader(token) },
      body: JSON.stringify({ recordingId, totalChunks, mimeType: metadata.mimeType }),
    });
    if (!initiateRes.ok) {
      const err = (await initiateRes.json().catch(() => ({}))) as { message?: string };
      throw new Error(err.message ?? `Initiate failed: ${initiateRes.status}`);
    }

    return recordingId;
  }

  private async uploadChunk(
    token: string,
    recordingId: string,
    chunkIndex: number,
    totalChunks: number,
    chunk: Blob,
    onProgress: (pct: number) => void,
  ): Promise<void> {
    const formData = new FormData();
    formData.append('chunk', chunk, `chunk-${chunkIndex}`);

    const url = `${API_BASE_URL}/uploads/chunk?recordingId=${encodeURIComponent(recordingId)}&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`;

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded * 100) / e.total));
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Chunk ${chunkIndex} upload failed: HTTP ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error(`Network error on chunk ${chunkIndex}`));
      xhr.ontimeout = () => reject(new Error(`Timeout on chunk ${chunkIndex}`));
      xhr.timeout = 60_000;
      xhr.send(formData);
    });
  }

  private async finalizeUpload(token: string, recordingId: string): Promise<string> {
    const res = await fetch(`${API_BASE_URL}/uploads/complete/${encodeURIComponent(recordingId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader(token) },
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(err.message ?? `Finalize failed: ${res.status}`);
    }
    const data = (await res.json()) as { data: { shareUrl?: string; url?: string } };
    return data.data.shareUrl ?? data.data.url ?? '';
  }

  private async abortUpload(token: string, recordingId: string): Promise<void> {
    try {
      await fetch(`${API_BASE_URL}/uploads/abort/${encodeURIComponent(recordingId)}`, {
        method: 'DELETE',
        headers: this.authHeader(token),
      });
    } catch {
      /* best-effort */
    }
  }

  // ─── Blob Utilities ────────────────────────────────────────────────────────

  private splitBlob(blob: Blob): Blob[] {
    const result: Blob[] = [];
    let offset = 0;
    while (offset < blob.size) {
      result.push(blob.slice(offset, offset + CHUNK_SIZE, blob.type));
      offset += CHUNK_SIZE;
    }
    return result;
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
