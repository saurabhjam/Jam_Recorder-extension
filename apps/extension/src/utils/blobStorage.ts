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
 * IDB key for a recording's separately-recorded microphone track.
 *
 * The mic is captured to its own blob rather than mixed into the video's audio, so
 * the editor can mute mic and system audio independently. Recordings made before
 * that split simply have no entry under this key.
 */
export function micBlobKey(recordingId: string): string {
  return `${recordingId}::mic`;
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
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}
