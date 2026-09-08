import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS, MAX_DRAFTS, type AuthTokens, type DraftRecording } from '@/types';
import { downloadBlob } from '@/utils';
import { loadRecordingBlob, deleteRecordingBlob, listStoredRecordings } from '@/utils/blobStorage';

async function readDrafts(): Promise<DraftRecording[]> {
  const result = await chrome.storage.local.get([STORAGE_KEYS.DRAFTS_INDEX]);
  return (result[STORAGE_KEYS.DRAFTS_INDEX] as DraftRecording[] | undefined) ?? [];
}

/** Drain blobs evicted from the 5-slot list by whichever earlier session
 *  registered them — this popup may be the first DOM-context page to open
 *  since. */
async function drainPendingCleanup(): Promise<void> {
  const result = await chrome.storage.local.get([STORAGE_KEYS.PENDING_BLOB_CLEANUP]);
  const pending = (result[STORAGE_KEYS.PENDING_BLOB_CLEANUP] as string[] | undefined) ?? [];
  if (pending.length === 0) return;
  await Promise.all(pending.map((id) => deleteRecordingBlob(id)));
  await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_BLOB_CLEANUP]: [] });
}

/**
 * Put recordings that exist on disk but in nobody's list back into Drafts.
 *
 * A recording is written to OPFS chunk by chunk while it runs, so by the time
 * anything can go wrong the file is already there and playable. Everything that
 * happens after Stop — finalizing, the ready message, opening the editor — is a
 * hand-off that can be interrupted (a killed service worker, a crashed offscreen
 * document, a browser quit), and until now an interrupted hand-off meant the
 * recording was simply unreachable forever: on disk, taking up space, with no UI
 * anywhere that knew its name. Anything found here is offered as a normal draft, so
 * it can be played, saved or downloaded like any other.
 *
 * Runs AFTER the eviction cleanup, so drafts the user has already pushed off the
 * end of the list stay deleted instead of coming back.
 */
async function recoverOrphanedRecordings(known: DraftRecording[]): Promise<DraftRecording[]> {
  const stored = await listStoredRecordings();
  if (stored.length === 0) return known;

  const state = await chrome.storage.local.get([
    STORAGE_KEYS.RECORDING_STATE,
    STORAGE_KEYS.PENDING_BLOB_CLEANUP,
  ]);
  // Never touch the recording currently being written — its file is incomplete and
  // it gets its own draft entry the moment it finishes.
  const liveId = (state[STORAGE_KEYS.RECORDING_STATE] as { recordingId?: string } | undefined)
    ?.recordingId;
  const queuedForDeletion = new Set(
    (state[STORAGE_KEYS.PENDING_BLOB_CLEANUP] as string[] | undefined) ?? [],
  );
  const knownIds = new Set(known.map((d) => d.recordingId));

  const orphans = stored.filter(
    (r) => r.id !== liveId && !knownIds.has(r.id) && !queuedForDeletion.has(r.id),
  );
  if (orphans.length === 0) return known;

  const recovered: DraftRecording[] = orphans.map((r) => ({
    recordingId: r.id,
    title: `Recovered recording (${new Date().toLocaleDateString()})`,
    thumbnailDataUrl: null,
    // Unknown until the editor loads the file and reads it off the <video>.
    duration: 0,
    blobSize: r.size,
    recordingType: 'screen',
    createdAt: Date.now(),
    status: 'draft',
    // Recovered files were written by the recorder itself, which mixes every audio
    // source into the main track — so they save with no re-encode, like any other.
    audioMixed: true,
  }));

  const next = [...known, ...recovered].slice(0, MAX_DRAFTS);
  if (next.length === known.length) return known; // list already full — nothing added
  await chrome.storage.local.set({ [STORAGE_KEYS.DRAFTS_INDEX]: next });
  return next;
}

function safeFileName(title: string): string {
  return (
    title
      .replace(/[^a-z0-9-_ ]/gi, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'recording'
  );
}

export function useDrafts() {
  const [drafts, setDrafts] = useState<DraftRecording[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setDrafts(await readDrafts());
  }, []);

  useEffect(() => {
    void (async () => {
      await drainPendingCleanup();
      const known = await readDrafts();
      setDrafts(await recoverOrphanedRecordings(known));
      setIsLoading(false);
    })();

    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && STORAGE_KEYS.DRAFTS_INDEX in changes) {
        setDrafts(
          (changes[STORAGE_KEYS.DRAFTS_INDEX].newValue as DraftRecording[] | undefined) ?? [],
        );
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const openInEditor = useCallback((recordingId: string) => {
    void chrome.windows.create({
      url: chrome.runtime.getURL(`src/editor/index.html?recordingId=${recordingId}`),
      type: 'popup',
      width: 1400,
      height: 900,
      focused: true,
    });
  }, []);

  const download = useCallback(async (draft: DraftRecording) => {
    setBusyId(draft.recordingId);
    try {
      const fileName = `${safeFileName(draft.title)}.webm`;
      if (draft.status === 'draft') {
        const blob = await loadRecordingBlob(draft.recordingId);
        if (!blob) throw new Error('Recording not found locally');
        downloadBlob(blob, fileName);
        return;
      }
      if (!draft.videoUrl) throw new Error('No uploaded file to download');
      const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH_TOKENS]);
      const tokens = result[STORAGE_KEYS.AUTH_TOKENS] as AuthTokens | undefined;
      const res = await fetch(draft.videoUrl, {
        headers: tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {},
      });
      if (!res.ok) throw new Error(`Could not fetch uploaded video (${res.status})`);
      downloadBlob(await res.blob(), fileName);
    } finally {
      setBusyId(null);
    }
  }, []);

  const discard = useCallback(async (recordingId: string) => {
    setBusyId(recordingId);
    try {
      const current = await readDrafts();
      const target = current.find((d) => d.recordingId === recordingId);
      const next = current.filter((d) => d.recordingId !== recordingId);
      await chrome.storage.local.set({ [STORAGE_KEYS.DRAFTS_INDEX]: next });
      setDrafts(next);
      if (target?.status === 'draft') {
        await deleteRecordingBlob(recordingId);
      }
    } finally {
      setBusyId(null);
    }
  }, []);

  return {
    drafts,
    isLoading,
    busyId,
    openInEditor,
    download: (d: DraftRecording) => void download(d),
    discard: (id: string) => void discard(id),
  };
}
