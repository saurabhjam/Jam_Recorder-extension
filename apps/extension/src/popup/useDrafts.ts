import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS, type AuthTokens, type DraftRecording } from '@/types';
import { downloadBlob } from '@/utils';
import { loadRecordingBlob, deleteRecordingBlob } from '@/utils/blobStorage';

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
      await refresh();
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
