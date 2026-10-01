/**
 * Shared OPFS/IndexedDB access for recording blobs. All extension pages
 * (offscreen, editor, popup) share the same origin, so a blob written by one
 * can be read or deleted by another. OPFS is the primary store — disk-backed,
 * used while the recorder is streaming chunks — with IndexedDB as a fallback
 * for browsers/contexts where OPFS is unavailable.
 */

const IDB_NAME = 'bestq-blobs';
const IDB_STORE = 'recordings';

/** OPFS filename for a recording's raw blob. */
export function recordingOpfsName(recordingId: string): string {
  return `recording-${recordingId}.webm`;
}

/**
 * IDB key for a recording's microphone-only track.
 *
 * The main recording already contains every audio source, so it can be saved with no
 * processing at all. This side track exists purely so the editor can rebuild the
 * audio when the user asks for mic-only (system audio muted). Recordings that used
 * no mic simply have no entry under this key.
 */
export function micBlobKey(recordingId: string): string {
  return `${recordingId}::mic`;
}

/**
 * IDB key for a recording's system/tab-audio-only track — the counterpart to
 * `micBlobKey`, used when the user mutes the mic. Only written when a recording had
 * both sources (with nothing to separate, there is nothing to store).
 */
export function systemBlobKey(recordingId: string): string {
  return `${recordingId}::sys`;
}

/**
 * The id a recording's processed (trimmed/re-mixed) file is stored under.
 *
 * Separate from the recording's own id so both exist at once: the original is
 * the thing that must never be lost, and it stays on disk until the server has
 * confirmed the processed one. The suffix keeps it out of the Drafts recovery
 * sweep, which looks for recordings, not derivatives.
 */
export function exportIdFor(recordingId: string): string {
  return `${recordingId}__export`;
}

/**
 * Write a blob to OPFS under `id`, replacing anything already there.
 *
 * Used for the processed file, so an upload that has to be retried later — in
 * another session, after a crash — never has to re-run a trim that can take as
 * long as the recording itself.
 */
export async function saveBlobToOPFS(id: string, blob: Blob): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(recordingOpfsName(id), { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    // Out of disk, or no OPFS here. The original is still on disk and the
    // upload still goes ahead from memory; only the cheap retry is lost.
    console.warn('[Storage] could not store the processed file:', err);
    return false;
  }
}

export function openRecordingIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBlobToIDB(id: string, blob: Blob): Promise<void> {
  const db = await openRecordingIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadBlobFromIDB(id: string): Promise<Blob | null> {
  try {
    const db = await openRecordingIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Read the recording from OPFS (disk-backed; where long recordings live). */
export async function loadBlobFromOPFS(id: string): Promise<Blob | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(recordingOpfsName(id));
    const file = await handle.getFile();
    return file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

/**
 * Load a recording's blob, preferring the OPFS file the recorder streams to,
 * falling back to the in-memory→IDB path for older/small recordings.
 */
export async function loadRecordingBlob(id: string): Promise<Blob | null> {
  return (await loadBlobFromOPFS(id)) ?? (await loadBlobFromIDB(id));
}

/** Free a recording's local copy once it's safely uploaded or discarded. */
export async function deleteRecordingBlob(id: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(recordingOpfsName(id));
  } catch {
    /* not in OPFS */
  }
  try {
    const db = await openRecordingIDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      // The side audio tracks are part of this recording — dropping only the video
      // left them behind forever, one orphaned blob per recording ever made.
      store.delete(id);
      store.delete(micBlobKey(id));
      store.delete(systemBlobKey(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/**
 * Every recording file sitting in OPFS, with its size.
 *
 * The recorder streams straight to disk, so a recording exists as a complete file
 * well before anything else knows about it. If the hand-off after Stop goes wrong —
 * the offscreen document dies, the worker is killed mid-teardown, the editor never
 * opens — the file is still right here, but nothing references it and the user has
 * no way to reach it. This is how those get found again (see the Drafts recovery
 * sweep in the popup); the id is the one embedded by `recordingOpfsName`.
 */
export async function listStoredRecordings(): Promise<Array<{ id: string; size: number }>> {
  try {
    const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
      values?: () => AsyncIterableIterator<FileSystemHandle>;
    };
    // Directory iteration is newer than the rest of OPFS; without it we simply
    // can't enumerate, and the caller treats that as "nothing to recover".
    if (typeof root.values !== 'function') return [];
    const found: Array<{ id: string; size: number }> = [];
    for await (const handle of root.values()) {
      if (handle.kind !== 'file') continue;
      const match = /^recording-(.+)\.webm$/.exec(handle.name);
      if (!match?.[1]) continue;
      // Processed copies live here too (see exportIdFor). They are derivatives
      // of a recording that is itself on disk, so offering one as a recovered
      // recording would show the same capture twice.
      if (match[1].endsWith('__export')) continue;
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        if (file.size > 0) found.push({ id: match[1], size: file.size });
      } catch {
        /* file vanished or is locked by the live recorder — skip it */
      }
    }
    return found;
  } catch {
    return [];
  }
}
