import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Copy,
  Check,
  Play,
  Pause,
  Maximize2,
  RotateCcw,
  Link2,
  Lock,
  LogIn,
  Download,
  Scissors,
  FolderOpen,
  ChevronDown,
  AlertCircle,
  ShieldCheck,
  FlaskConical,
  Tag,
  X,
  Globe,
  Clock,
} from 'lucide-react';
import { buildShareUrl, API_BASE_URL as API_BASE, INSTANCE_LABEL, IS_PRODUCTION } from '@/config';
import { retryWithBackoff } from '@/utils';
import {
  loadRecordingBlob,
  deleteRecordingBlob,
  loadBlobFromIDB,
  micBlobKey,
} from '@/utils/blobStorage';
import { STORAGE_KEYS, type DraftRecording } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EditorData {
  recordingId: string;
  thumbnailDataUrl: string | null;
  duration: number;
  blobSize: number;
  title: string;
  recordingType?: string;
  consoleLogs: ConsoleLog[];
  networkCaptures: NetworkCapture[];
  visitedUrls?: VisitedUrl[];
}

interface VisitedUrl {
  url: string;
  title: string;
  tabId: number;
  timestamp: number;
  favIconUrl?: string;
}

interface ConsoleLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: number;
  url: string;
  source?: 'cdp' | 'injected';
}

interface NetworkCapture {
  id?: string;
  url: string;
  method: string;
  status: number;
  statusText?: string;
  duration: number;
  timestamp: number;
  size: number;
  mimeType?: string;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  source?: 'cdp' | 'injected';
}

/** Convert a captured header map to the HAR `[{name, value}]` shape. */
function toHarHeaders(headers?: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

interface AssignedProjectInfo {
  projectId: number;
  projectRole: string;
  entryType: string;
}

type LogTab = 'console' | 'network' | 'links' | 'info';

// ─── Constants ────────────────────────────────────────────────────────────────
const EDITOR_DATA_KEY = 'st_editor_data';
const PENDING_SHARE_KEY = 'st_pending_share';
const SHARE_VISIBILITY_KEY = 'st_share_visibility';
const AUTH_TOKENS_KEY = 'st_auth_tokens';
const AUTH_USER_KEY = 'st_auth_user';
const DESCRIPTION_MAX = 125;

type Visibility = 'private' | 'public';

interface ShareVisibilityState {
  recordingId: string;
  backendId: string;
  project: string;
  visibility: Visibility;
  // epoch ms; null means "never expires" (only meaningful while visibility === 'public')
  shareExpiresAt: number | null;
  publicShareUrl: string | null;
}

/** Preset durations for the public-sharing dropdown. `minutes: 0` means never expires. */
const SHARE_DURATION_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '30 minutes', minutes: 30 },
  { label: '6 hours', minutes: 6 * 60 },
  { label: '7 days', minutes: 7 * 24 * 60 },
  { label: '3 months', minutes: 90 * 24 * 60 },
  { label: 'Always (no expiry)', minutes: 0 },
];

/** "2h 14m", "5d 3h", "Never" — for the remaining-time chip in the visibility popover. */
function formatRemaining(expiresAt: number | null): string {
  if (expiresAt === null) return 'Never expires';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'Expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `Expires in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Expires in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `Expires in ${days}d ${hours % 24}h`;
}

/**
 * Re-encode a recorded video blob to [startSec, endSec] entirely in the browser,
 * optionally dropping its audio.
 *
 * There's no ffmpeg here, so we re-record: play the source <video> from the trim
 * start to the trim end while capturing its stream through MediaRecorder. This is
 * real-time (a 30s clip takes ~30s) but needs no native deps and preserves audio.
 * `onProgress` reports 0–1 based on how far through the selection we are.
 *
 * `audio` controls the mix. The mic is recorded to its own blob (see
 * offscreen/index.ts), so it's played back alongside the video and the two are
 * summed here through gain-free source nodes — muting either simply omits it.
 * Muting both yields a video-only (silent) export.
 */
async function trimVideoBlob(
  blob: Blob,
  startSec: number,
  endSec: number,
  onProgress?: (fraction: number) => void,
  audio: { micBlob?: Blob | null; muteSystem?: boolean; muteMic?: boolean } = {},
): Promise<Blob> {
  const { micBlob = null, muteSystem = false, muteMic = false } = audio;
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true; // muted so autoplay is allowed; audio track is still captured
  video.playsInline = true;

  // The mic lives in its own file, so it's played back alongside the video and the
  // two are mixed here — that's what makes muting one without the other possible.
  const micUrl = micBlob ? URL.createObjectURL(micBlob) : null;
  const micEl = micUrl ? new Audio(micUrl) : null;
  if (micEl) micEl.muted = true; // as above: keep it off the speakers, still capturable
  let audioCtx: AudioContext | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not load recording for trimming'));
    });
    if (micEl) {
      await new Promise<void>((resolve) => {
        // A missing/!unreadable mic track must not block the export.
        micEl.onloadedmetadata = () => resolve();
        micEl.onerror = () => resolve();
      });
    }

    const capture = video as HTMLVideoElement & { captureStream?: () => MediaStream };
    const stream = capture.captureStream?.();
    if (!stream) throw new Error('captureStream unavailable — cannot trim in this browser');

    // Pull the source audio out of the recorded stream so it can be re-mixed with
    // per-source gains instead of being passed through wholesale.
    const systemTracks = stream.getAudioTracks();
    for (const track of systemTracks) stream.removeTrack(track);

    const wantSystem = !muteSystem && systemTracks.length > 0;
    const micCapture = micEl as (HTMLAudioElement & { captureStream?: () => MediaStream }) | null;
    const micStreamForMix = !muteMic && micCapture ? micCapture.captureStream?.() : undefined;
    const micTracks = micStreamForMix?.getAudioTracks() ?? [];
    const wantMic = micTracks.length > 0;

    if (wantSystem || wantMic) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      if (wantSystem) {
        audioCtx.createMediaStreamSource(new MediaStream(systemTracks)).connect(dest);
      }
      if (wantMic) {
        audioCtx.createMediaStreamSource(new MediaStream(micTracks)).connect(dest);
      }
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    }
    // Neither wanted → the stream stays video-only, i.e. a silent export.

    // Stop the discarded source tracks so they don't keep decoding in the background.
    if (!wantSystem) for (const t of systemTracks) t.stop();

    // Prefer a codec the recorder actually supports; fall back to default.
    const preferred = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    // Seek to the start of the selection before recording.
    video.currentTime = startSec;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });
    // Line the mic up with the same instant — both were recorded from t=0.
    if (micEl && micTracks.length > 0) {
      micEl.currentTime = Math.min(startSec, micEl.duration || startSec);
    }

    recorder.start(100);
    await video.play();
    if (micEl && micTracks.length > 0) {
      try {
        await micEl.play();
      } catch {
        /* mic playback blocked → export continues with system audio only */
      }
    }

    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = video.currentTime;
        onProgress?.(Math.max(0, Math.min(1, (t - startSec) / Math.max(0.001, endSec - startSec))));
        if (t >= endSec || video.ended) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });

    video.pause();
    micEl?.pause();
    recorder.stop();
    await stopped;
    return new Blob(chunks, { type: mimeType.split(';')[0] || 'video/webm' });
  } finally {
    URL.revokeObjectURL(url);
    if (micUrl) URL.revokeObjectURL(micUrl);
    void audioCtx?.close().catch(() => {});
  }
}

/**
 * Merge a partial update into a Drafts-list entry (matched by recordingId).
 * A no-op if the entry isn't in the list (e.g. it was discarded meanwhile).
 */
async function patchDraftIndex(recordingId: string, patch: Partial<DraftRecording>): Promise<void> {
  const result = await chrome.storage.local.get([STORAGE_KEYS.DRAFTS_INDEX]);
  const drafts = (result[STORAGE_KEYS.DRAFTS_INDEX] as DraftRecording[] | undefined) ?? [];
  const next = drafts.map((d) => (d.recordingId === recordingId ? { ...d, ...patch } : d));
  await chrome.storage.local.set({ [STORAGE_KEYS.DRAFTS_INDEX]: next });
}

/**
 * Flip a Drafts-list entry from `status: 'draft'` to `'saved'` once the editor
 * has successfully uploaded it. The entry is kept (not removed) so it still
 * shows in Drafts, now with Download/Copy Link instead of Save/Download.
 */
async function promoteDraftToSaved(
  recordingId: string,
  saved: Pick<DraftRecording, 'title' | 'backendRecordId' | 'shareUrl' | 'videoUrl' | 'isPublic'>,
): Promise<void> {
  await patchDraftIndex(recordingId, { ...saved, status: 'saved' });
}

/** Trigger a browser download of a blob under the given filename. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDur(secs: number): string {
  if (!isFinite(secs) || isNaN(secs) || secs < 0) return '00:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

// ─── EditorApp ────────────────────────────────────────────────────────────────

export function EditorApp() {
  const params = new URLSearchParams(window.location.search);
  const recordingId = params.get('recordingId') ?? '';

  const [data, setData] = useState<EditorData | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [backendRecordId, setBackendRecordId] = useState<string | null>(null);
  const [savedProject, setSavedProject] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [shareExpiresAt, setShareExpiresAt] = useState<number | null>(null);
  const [publicShareUrl, setPublicShareUrl] = useState<string | null>(null);
  const [isVisibilityBusy, setIsVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  // Set when the user picks "Public" before the recording has been saved (no
  // recordId exists yet to attach a share token to). Materialized into a real
  // token by the effect below as soon as backendRecordId becomes available.
  const [pendingShareMinutes, setPendingShareMinutes] = useState<number | null>(null);
  // Mirrors the record's persisted `isPublic` flag so we never issue a
  // redundant PATCH: the record is CREATED with the right value (see handleSave),
  // and patchRecordIsPublic only fires when the flag actually needs to change.
  const recordIsPublicRef = useRef(false);
  // Remote URL of the uploaded (already-trimmed) video file. Lets Download work
  // after the local OPFS/IDB copy is reclaimed on upload — see handleDownload.
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Progress phase label shown next to the % while saving (trim → upload).
  const [saveStage, setSaveStage] = useState<'idle' | 'trimming' | 'uploading'>('idle');
  const [isDownloading, setIsDownloading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<LogTab>('console');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(1); // 0–1 fractions of total duration
  // Independent audio mutes for the saved/downloaded file. The mic is recorded to
  // its own track (see offscreen/index.ts), so each source can be dropped on its own.
  const [muteSystemAudio, setMuteSystemAudio] = useState(false);
  const [muteMic, setMuteMic] = useState(false);
  // Object URL + blob for the separately-recorded mic track, when one exists.
  const [micUrl, setMicUrl] = useState<string | null>(null);
  const micBlobRef = useRef<Blob | null>(null);
  const micAudioRef = useRef<HTMLAudioElement | null>(null);
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null);
  const [assignedProjects, setAssignedProjects] = useState<Record<
    string,
    AssignedProjectInfo
  > | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // A thumbnail captured from the <video> in-editor, used when the recording has
  // none of its own — e.g. a video the user uploaded from local disk (which
  // arrives with thumbnailDataUrl: null). Captured once on first load.
  const [derivedThumbnail, setDerivedThumbnail] = useState<string | null>(null);
  const thumbCaptureStartedRef = useRef(false);

  // ── Load editor data + blob from IDB ───────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const result = await chrome.storage.local.get([
        EDITOR_DATA_KEY,
        PENDING_SHARE_KEY,
        SHARE_VISIBILITY_KEY,
        AUTH_TOKENS_KEY,
        AUTH_USER_KEY,
      ]);

      const stored = result[EDITOR_DATA_KEY] as EditorData | undefined;
      if (stored) {
        setData(stored);
        setTitle(stored.title);
      }

      const pending = result[PENDING_SHARE_KEY] as
        | { shareUrl: string; recordingId: string; videoUrl?: string }
        | undefined;
      if (pending?.shareUrl && (!recordingId || pending.recordingId === recordingId)) {
        setShareUrl(pending.shareUrl);
        if (pending.videoUrl) setUploadedVideoUrl(pending.videoUrl);
        setUploadPercent(100);
      }

      const visState = result[SHARE_VISIBILITY_KEY] as ShareVisibilityState | undefined;
      if (visState && visState.recordingId === recordingId) {
        setBackendRecordId(visState.backendId);
        setSavedProject(visState.project);
        // Expiry is re-validated below by the dedicated effect too, but check here
        // as well so a reload right after expiry doesn't briefly show stale "Public".
        const stillActive =
          visState.visibility === 'public' &&
          (visState.shareExpiresAt === null || Date.now() < visState.shareExpiresAt);
        setVisibility(stillActive ? 'public' : 'private');
        setShareExpiresAt(stillActive ? visState.shareExpiresAt : null);
        setPublicShareUrl(stillActive ? visState.publicShareUrl : null);
      }

      const tokens = result[AUTH_TOKENS_KEY] as { accessToken?: string } | undefined;
      setIsAuthenticated(!!tokens?.accessToken);

      // Load user's assigned projects from stored user…
      const user = result[AUTH_USER_KEY] as
        | { assignedProjects?: Record<string, AssignedProjectInfo> }
        | undefined;
      if (user?.assignedProjects && Object.keys(user.assignedProjects).length > 0) {
        setAssignedProjects(user.assignedProjects);
      } else if (tokens?.accessToken) {
        // …or fetch fresh from the API for users who signed in before this feature.
        try {
          const res = await fetch(`${API_BASE}/users?ids=`, {
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' },
          });
          if (res.ok) {
            const raw = (await res.json()) as
              | { assignedProjects?: Record<string, AssignedProjectInfo> }
              | Array<{ assignedProjects?: Record<string, AssignedProjectInfo> }>;
            const projects = Array.isArray(raw) ? raw[0]?.assignedProjects : raw?.assignedProjects;
            if (projects && Object.keys(projects).length > 0) setAssignedProjects(projects);
          }
        } catch {
          /* network unavailable — dropdown stays empty */
        }
      }
    };
    void load();
  }, [recordingId]);

  // ── Drain any drafts evicted from the 5-slot Drafts list before we got here —
  // their local blob is still sitting in OPFS/IDB until someone with DOM access
  // (this editor, or the popup) actually deletes it.
  useEffect(() => {
    void (async () => {
      const result = await chrome.storage.local.get([STORAGE_KEYS.PENDING_BLOB_CLEANUP]);
      const pending = (result[STORAGE_KEYS.PENDING_BLOB_CLEANUP] as string[] | undefined) ?? [];
      if (pending.length === 0) return;
      await Promise.all(pending.map((id) => deleteRecordingBlob(id)));
      await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_BLOB_CLEANUP]: [] });
    })();
  }, []);

  // ── Poll storage for data (editor opens before storage write in some cases) ─
  useEffect(() => {
    if (data) return;
    const id = setInterval(async () => {
      const result = await chrome.storage.local.get([EDITOR_DATA_KEY]);
      const stored = result[EDITOR_DATA_KEY] as EditorData | undefined;
      if (stored) {
        setData(stored);
        setTitle(stored.title);
        clearInterval(id);
      }
    }, 500);
    return () => clearInterval(id);
  }, [data]);

  // ── Load video blob from IDB ───────────────────────────────────────────────
  useEffect(() => {
    if (!recordingId || recordingId === 'unknown') return;
    let objectUrl: string | null = null;
    const tryLoad = async () => {
      const blob = await loadRecordingBlob(recordingId);
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        setVideoUrl(objectUrl);
      }
    };
    void tryLoad();
    // Retry a few times in case the blob is still being written
    const retryTimer = setTimeout(() => {
      void tryLoad();
    }, 1500);
    return () => {
      clearTimeout(retryTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recordingId]);

  // ── Load the separately-recorded mic track, when there is one ──────────────
  // Recorded to its own blob so mic and system audio stay independently mutable.
  // Absent for recordings made before that split (and when no mic was used) — the
  // UI then offers only the system-audio control.
  useEffect(() => {
    if (!recordingId || recordingId === 'unknown') return;
    let objectUrl: string | null = null;
    let cancelled = false;
    const tryLoad = async () => {
      const blob = await loadBlobFromIDB(micBlobKey(recordingId));
      if (blob && blob.size > 0 && !cancelled) {
        micBlobRef.current = blob;
        objectUrl = URL.createObjectURL(blob);
        setMicUrl(objectUrl);
      }
    };
    void tryLoad();
    const retryTimer = setTimeout(() => {
      if (!micBlobRef.current) void tryLoad();
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recordingId]);

  // ── Listen for auth changes ────────────────────────────────────────────────
  useEffect(() => {
    const listener = (message: { type: string }) => {
      if (message.type === 'OAUTH_LOGIN_COMPLETE') setIsAuthenticated(true);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // Flip the record's `isPublic` flag so it reflects the sharing state (the
  // backend also uses it to allow anonymous GET of the record — see
  // RecordController.getRecordById's anonymous path). Best-effort: the share
  // token, not this flag, is what actually gates timed access, so a failed
  // PATCH must not block the toggle.
  const patchRecordIsPublic = useCallback(
    async (isPublic: boolean) => {
      if (!backendRecordId || !savedProject) return;
      // Already in the desired state (e.g. the record was created public because
      // the user chose "Public" before saving) — skip the redundant PATCH.
      if (recordIsPublicRef.current === isPublic) return;
      try {
        const r = await chrome.storage.local.get([AUTH_TOKENS_KEY]);
        const token = (r[AUTH_TOKENS_KEY] as { accessToken?: string } | undefined)?.accessToken;
        if (!token) return;
        await fetch(`${API_BASE}/v1/${savedProject}/records/${backendRecordId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ isPublic }),
        });
        recordIsPublicRef.current = isPublic;
      } catch {
        /* non-fatal — sharing state is driven by the share token, not this flag */
      }
    },
    [backendRecordId, savedProject],
  );

  // ── Auto-revert to Private once the share link's expiry passes ────────────
  // The backend independently rejects an expired token on access, so this is
  // purely cosmetic — it keeps the toggle/badge in this open tab honest without
  // requiring a reload. Skipped entirely for "never expires" (shareExpiresAt null).
  useEffect(() => {
    if (visibility !== 'public' || shareExpiresAt === null) return;
    const checkExpiry = () => {
      if (Date.now() < shareExpiresAt) return;
      setVisibility('private');
      setShareExpiresAt(null);
      setPublicShareUrl(null);
      if (backendRecordId && savedProject) {
        void chrome.storage.local.set({
          [SHARE_VISIBILITY_KEY]: {
            recordingId,
            backendId: backendRecordId,
            project: savedProject,
            visibility: 'private',
            shareExpiresAt: null,
            publicShareUrl: null,
          } satisfies ShareVisibilityState,
        });
        void patchRecordIsPublic(false);
        void patchDraftIndex(recordingId, { shareUrl: shareUrl ?? undefined, isPublic: false });
      }
    };
    checkExpiry();
    const id = setInterval(checkExpiry, 15_000);
    return () => clearInterval(id);
  }, [
    visibility,
    shareExpiresAt,
    backendRecordId,
    savedProject,
    recordingId,
    patchRecordIsPublic,
    shareUrl,
  ]);

  const handleCopyLink = async () => {
    const linkToCopy = visibility === 'public' && publicShareUrl ? publicShareUrl : shareUrl;
    if (!linkToCopy) return;
    await navigator.clipboard.writeText(linkToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenSignIn = () => chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });

  // Mints a time-scoped private share token for a record and returns the public
  // share URL + expiry. Pure request helper — shared by handleSave (public save)
  // and applyPublicVisibility (post-save toggle) so both produce the SAME link.
  // `minutes: 0` requests a token that never expires.
  const mintShareToken = useCallback(async (project: string, recordId: string, minutes: number) => {
    const tokenResult = await chrome.storage.local.get([AUTH_TOKENS_KEY]);
    const token = (tokenResult[AUTH_TOKENS_KEY] as { accessToken?: string } | undefined)
      ?.accessToken;
    if (!token) throw new Error('Not authenticated — please sign in.');
    const res = await fetch(`${API_BASE}/v1/${project}/records/${recordId}/share-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ expireInMinutes: minutes }),
    });
    if (!res.ok) throw new Error(`Failed to enable public sharing (${res.status})`);
    const body = (await res.json()) as { shareToken: string; expiresAt: string | null };
    const expiresAtMs = body.expiresAt ? new Date(body.expiresAt).getTime() : null;
    // Build the share URL from RP_HOST (this build's configured portal host)
    // rather than the server's `url` field. The server derives its URL from the
    // incoming request, which — behind a proxy/LAN routing — comes out as an
    // internal address like http://192.168.x.x:8080 that no external viewer can
    // reach. RP_HOST is by definition reachable: the extension just successfully
    // called the API at this same host to mint the token.
    const url = buildShareUrl(project, recordId, body.shareToken);
    return { url, expiresAtMs };
  }, []);

  // Switches an ALREADY-SAVED recording to Public by minting a share token.
  // (Pre-save "Public" is handled inline in handleSave so the copied link is
  // correct immediately.) Returns the public URL, or null on failure.
  const applyPublicVisibility = useCallback(
    async (minutes: number): Promise<string | null> => {
      if (!backendRecordId || !savedProject) return null;
      setIsVisibilityBusy(true);
      setVisibilityError(null);
      try {
        const { url, expiresAtMs } = await mintShareToken(savedProject, backendRecordId, minutes);
        setVisibility('public');
        setShareExpiresAt(expiresAtMs);
        setPublicShareUrl(url);
        await chrome.storage.local.set({
          [SHARE_VISIBILITY_KEY]: {
            recordingId,
            backendId: backendRecordId,
            project: savedProject,
            visibility: 'public',
            shareExpiresAt: expiresAtMs,
            publicShareUrl: url,
          } satisfies ShareVisibilityState,
        });
        await patchRecordIsPublic(true);
        void patchDraftIndex(recordingId, { shareUrl: url, isPublic: true });
        return url;
      } catch (err) {
        setVisibilityError(err instanceof Error ? err.message : 'Failed to update sharing');
        return null;
      } finally {
        setIsVisibilityBusy(false);
      }
    },
    [backendRecordId, savedProject, recordingId, patchRecordIsPublic, mintShareToken],
  );

  // Reverts the toggle to Private in this extension. NOTE: the backend has no
  // token-revoke endpoint yet, so a link already generated/shared stays valid
  // server-side until it naturally expires — this stops offering/copying it going
  // forward, it does not retroactively kill an already-distributed link.
  const setPrivateVisibility = useCallback(() => {
    setVisibility('private');
    setShareExpiresAt(null);
    setPublicShareUrl(null);
    setPendingShareMinutes(null);
    if (backendRecordId && savedProject) {
      void chrome.storage.local.set({
        [SHARE_VISIBILITY_KEY]: {
          recordingId,
          backendId: backendRecordId,
          project: savedProject,
          visibility: 'private',
          shareExpiresAt: null,
          publicShareUrl: null,
        } satisfies ShareVisibilityState,
      });
      void patchRecordIsPublic(false);
      void patchDraftIndex(recordingId, { shareUrl: shareUrl ?? undefined, isPublic: false });
    }
  }, [backendRecordId, savedProject, recordingId, patchRecordIsPublic, shareUrl]);

  // Entry point the dropdown calls when the user picks a duration. The recording
  // may not be saved yet — the share-tokens API needs a real recordId, which
  // doesn't exist pre-save — so this either applies immediately (already saved)
  // or just remembers the choice for the effect below to apply right after save.
  const choosePublicVisibility = useCallback(
    (minutes: number) => {
      setVisibilityError(null);
      if (backendRecordId && savedProject) {
        void applyPublicVisibility(minutes);
      } else {
        setVisibility('public');
        setPendingShareMinutes(minutes);
      }
    },
    [backendRecordId, savedProject, applyPublicVisibility],
  );

  // Re-fetch the user's assigned projects from the API (called when the project
  // dropdown opens) so newly-granted projects show up without signing in again.
  // Result is cached back onto the stored user for instant population next time.
  const refreshProjects = useCallback(async () => {
    try {
      const r = await chrome.storage.local.get([AUTH_TOKENS_KEY]);
      const token = (r[AUTH_TOKENS_KEY] as { accessToken?: string } | undefined)?.accessToken;
      if (!token) return;
      const res = await fetch(`${API_BASE}/users`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) return;
      const raw = (await res.json()) as
        | { assignedProjects?: Record<string, AssignedProjectInfo> }
        | Array<{ assignedProjects?: Record<string, AssignedProjectInfo> }>;
      const projects = Array.isArray(raw) ? raw[0]?.assignedProjects : raw?.assignedProjects;
      if (projects && Object.keys(projects).length > 0) {
        setAssignedProjects(projects);
        const stored = await chrome.storage.local.get([AUTH_USER_KEY]);
        const user = (stored[AUTH_USER_KEY] as Record<string, unknown> | undefined) ?? {};
        await chrome.storage.local.set({
          [AUTH_USER_KEY]: { ...user, assignedProjects: projects },
        });
      }
    } catch {
      /* network unavailable — keep whatever projects we already have */
    }
  }, []);

  // Upload just the video file (the big, slow part) and return the MinIO
  // filename the server assigns. Retried with backoff; a 4xx fails fast.
  const uploadVideoFile = useCallback(
    (project: string, token: string, blob: Blob, onPct: (p: number) => void): Promise<string> =>
      retryWithBackoff(
        () =>
          new Promise<string>((resolve, reject) => {
            const videoFile = new File([blob], `recording-${Date.now()}.webm`, {
              type: (blob.type || 'video/webm').split(';')[0],
            });
            const formData = new FormData();
            formData.append('file', videoFile);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/v1/${project}/files/upload`);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.setRequestHeader('Accept', 'text/plain, application/json, */*');
            xhr.timeout = 30 * 60 * 1000; // 30 min ceiling for very large uploads
            const startedAt = performance.now();
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                const secs = ((performance.now() - startedAt) / 1000).toFixed(1);
                console.info(`[Editor] Video uploaded (${blob.size} bytes) in ${secs}s`);
                resolve(xhr.responseText.trim());
              } else {
                const err = new Error(
                  xhr.status === 413
                    ? 'Video is too large for the server to accept in one upload.'
                    : `Video upload failed (${xhr.status})`,
                ) as Error & { noRetry?: boolean };
                if (xhr.status >= 400 && xhr.status < 500) err.noRetry = true;
                reject(err);
              }
            };
            xhr.onerror = () => {
              console.warn('[Editor] Video upload network error — will retry');
              reject(new Error('Network error during video upload'));
            };
            xhr.ontimeout = () => reject(new Error('Video upload timed out'));
            xhr.send(formData);
          }),
        3,
      ),
    [],
  );

  // Load the recording and apply the current trim selection. Returns the raw blob
  // unchanged when the whole clip is selected (skips the costly re-encode). Shared
  // by Save (upload) and Download (local) so the trim always applies to both.
  const getExportBlob = useCallback(
    async (onTrimProgress?: (f: number) => void): Promise<Blob> => {
      const blob = await loadRecordingBlob(recordingId);
      if (!blob || blob.size === 0) throw new Error('Recording not found in local storage');
      const dur = videoDuration || data?.duration || 0;
      const isFullClip = trimStart <= 0.005 && trimEnd >= 0.995;
      const micBlob = micBlobRef.current;
      // The mic is a separate track, so it has to be mixed in during the re-encode
      // whenever it exists — not just when trimming or muting.
      const needsRemux = muteSystemAudio || muteMic || !!micBlob;
      if ((isFullClip && !needsRemux) || dur <= 0) return blob;
      const from = isFullClip ? 0 : trimStart * dur;
      const to = isFullClip ? dur : trimEnd * dur;
      return trimVideoBlob(blob, from, to, onTrimProgress, {
        micBlob,
        muteSystem: muteSystemAudio,
        muteMic,
      });
    },
    [recordingId, videoDuration, data, trimStart, trimEnd, muteSystemAudio, muteMic],
  );

  // Returns the record's share URL on success (so callers like "Save & Copy
  // Link" can copy it immediately), or null if the save was skipped/failed.
  const handleSave = useCallback(async (): Promise<string | null> => {
    if (!data || !recordingId || isSaving) return shareUrl;
    if (shareUrl) return shareUrl;

    // Check if a project is selected
    if (!selectedProjectName) {
      setUploadError('Please select a project to save your recording');
      return null;
    }

    setIsSaving(true);
    setUploadPercent(0);
    setUploadError(null);
    try {
      const tokenResult = await chrome.storage.local.get([AUTH_TOKENS_KEY, AUTH_USER_KEY]);
      const token = (tokenResult[AUTH_TOKENS_KEY] as { accessToken?: string } | undefined)
        ?.accessToken;
      const userId = (tokenResult[AUTH_USER_KEY] as { id?: string } | undefined)?.id ?? null;
      if (!token) {
        setUploadError('Not authenticated — please sign in.');
        return null;
      }

      // Build the export blob — applies the trim selection when the user picked a
      // sub-range (trim progress drives 0–15% of the bar).
      setSaveStage('trimming');
      const blob = await getExportBlob((f) => setUploadPercent(Math.round(f * 15)));
      if (!blob || blob.size === 0) throw new Error('Recording not found in local storage');

      const mime = blob.type || 'video/webm';
      const mimeBase = mime.split(';')[0] ?? 'video/webm';
      const ts = Date.now();
      const isoNow = new Date(ts).toISOString();
      const shareId = `share-${ts}`;

      // Use the selected project instead of fetching the first one
      const project = selectedProjectName;
      const projectId = assignedProjects?.[project]?.projectId ?? null;

      // Step 2: upload the video → MinIO filename (drives 15–80% of the bar).
      setSaveStage('uploading');
      const videoFileName = await uploadVideoFile(project, token, blob, (p) =>
        setUploadPercent(15 + Math.round(p * 0.65)),
      );
      setUploadPercent(80);

      // Step 3: upload HAR (network logs) → get MinIO filename
      setUploadPercent(82);
      let harFileName = '';
      try {
        const harData = {
          log: {
            version: '1.2',
            creator: { name: 'BestQ', version: '1.0' },
            entries: (data.networkCaptures ?? []).map((r) => ({
              startedDateTime: new Date(r.timestamp).toISOString(),
              time: r.duration,
              request: {
                method: r.method,
                url: r.url,
                headers: toHarHeaders(r.requestHeaders),
                queryString: [],
                cookies: [],
                headersSize: -1,
                bodySize: r.requestBody?.length ?? -1,
                ...(r.requestBody
                  ? {
                      postData: {
                        mimeType:
                          r.requestHeaders?.['Content-Type'] ??
                          r.requestHeaders?.['content-type'] ??
                          '',
                        text: r.requestBody,
                      },
                    }
                  : {}),
              },
              response: {
                status: r.status,
                statusText: r.statusText ?? '',
                headers: toHarHeaders(r.responseHeaders),
                content: {
                  size: r.size,
                  mimeType: r.mimeType ?? '',
                  ...(r.responseBody ? { text: r.responseBody } : {}),
                },
                redirectURL: '',
                headersSize: -1,
                bodySize: r.size,
              },
              cache: {},
              timings: { send: 0, wait: r.duration, receive: 0 },
            })),
          },
        };
        const harFile = new File([JSON.stringify(harData)], `har-${ts}.json`, {
          type: 'application/json',
        });
        const hForm = new FormData();
        hForm.append('file', harFile);
        const hRes = await fetch(`${API_BASE}/v1/${project}/files/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/plain, application/json, */*',
          },
          body: hForm,
        });
        if (hRes.ok) harFileName = (await hRes.text()).trim();
      } catch {
        /* best-effort */
      }

      // Step 4: upload console logs → get MinIO filename
      setUploadPercent(88);
      let logsFileName = '';
      try {
        const logsText = (data.consoleLogs ?? [])
          .map(
            (l) =>
              `[${new Date(l.timestamp).toISOString()}] [${l.level.toUpperCase()}] ${l.message}`,
          )
          .join('\n');
        const logsFile = new File([logsText], `console-${ts}.txt`, { type: 'text/plain' });
        const lForm = new FormData();
        lForm.append('file', logsFile);
        const lRes = await fetch(`${API_BASE}/v1/${project}/files/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/plain, application/json, */*',
          },
          body: lForm,
        });
        if (lRes.ok) logsFileName = (await lRes.text()).trim();
      } catch {
        /* best-effort */
      }

      // Step 4b: upload thumbnail as a file → store a URL instead of inlining
      // base64 into the record row. Falls back to the data URL on failure.
      // NOTE: the files GET endpoint requires a Bearer token, so the portal
      // must fetch this URL with auth (a plain <img src> gets a 401).
      setUploadPercent(90);
      // Use the recording's own thumbnail, or the one captured in-editor from the
      // <video> for local uploads that arrived without one.
      const thumbSource = data.thumbnailDataUrl ?? derivedThumbnail;
      let thumbnailUrl: string | null = thumbSource;
      if (thumbSource) {
        try {
          const thumbBlob = await (await fetch(thumbSource)).blob();
          const thumbFile = new File([thumbBlob], `thumb-${ts}.jpg`, { type: 'image/jpeg' });
          const tForm = new FormData();
          tForm.append('file', thumbFile);
          const tRes = await fetch(`${API_BASE}/v1/${project}/files/upload`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'text/plain, application/json, */*',
            },
            body: tForm,
          });
          if (tRes.ok) {
            const thumbFileName = (await tRes.text()).trim();
            if (thumbFileName) thumbnailUrl = `${API_BASE}/v1/${project}/files/${thumbFileName}`;
          }
        } catch {
          /* best-effort — keep data URL fallback */
        }
      }

      // Step 5: create record with all fields.
      // If the user already flipped the toggle to Public before saving, create
      // the record public in this ONE call — avoids a second PATCH /records/{id}
      // round-trip afterward (the share token is still minted separately, since
      // file access requires it).
      const createPublic = visibility === 'public';
      recordIsPublicRef.current = createPublic;
      setUploadPercent(92);
      const videoUrl = `${API_BASE}/v1/${project}/files/${videoFileName}`;
      const createRes = await fetch(`${API_BASE}/v1/${project}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: title || data.title,
          description: description.trim().slice(0, 125) || 'Recording captured with BestQ',
          tags: tags.join(','),
          type: 'video',
          mimeType: mimeBase,
          status: 'completed',
          userId,
          projectId: projectId !== null ? String(projectId) : '1',
          shareId,
          isPublic: createPublic,
          allowDownload: true,
          viewCount: 0,
          url: videoUrl,
          thumbnailUrl,
          // Size of the blob actually uploaded (post-trim), in bytes.
          size: blob.size,
          duration: Math.round((trimEnd - trimStart) * (videoDuration || data.duration || 0)),
          networkLogs: harFileName || null,
          consoleLogs: logsFileName || null,
          links: JSON.stringify(
            (data.visitedUrls ?? []).map((v) => ({
              time: formatTime(v.timestamp),
              title: v.title,
              url: v.url,
            })),
          ),
          metadata: JSON.stringify({
            browser: 'chrome',
            source: (data.recordingType ?? 'tab').toLowerCase(),
            harEntries: data.networkCaptures?.length ?? 0,
            consoleLogEntries: data.consoleLogs?.length ?? 0,
          }),
          createdAt: isoNow,
          updatedAt: isoNow,
        }),
      });
      if (!createRes.ok) {
        const e = (await createRes.json().catch(() => ({}))) as {
          message?: string;
          details?: unknown;
        };
        const detail = e.details ? ` (${JSON.stringify(e.details)})` : '';
        throw new Error(`${e.message ?? `Create recording failed (${createRes.status})`}${detail}`);
      }
      const createBody = (await createRes.json()) as { id: string };
      const backendId = createBody.id;

      // Step 6: build the share link. The base record URL is always set; if the
      // user chose Public before saving, mint the share token now (inline) so the
      // link we return/copy is the SAME token URL the bottom "Copy Link" uses —
      // no async gap where the plain URL would be copied by mistake.
      const newShareUrl = buildShareUrl(project, backendId);
      let finalLink = newShareUrl;
      let publicUrl: string | null = null;
      let publicExpiresAt: number | null = null;
      if (createPublic) {
        try {
          const minted = await mintShareToken(project, backendId, pendingShareMinutes ?? 0);
          publicUrl = minted.url;
          publicExpiresAt = minted.expiresAtMs;
          finalLink = minted.url;
        } catch {
          /* token mint failed — record is still public; fall back to base URL */
        }
      }
      setShareUrl(newShareUrl);
      setBackendRecordId(backendId);
      setSavedProject(project);
      setUploadedVideoUrl(videoUrl);
      setPendingShareMinutes(null);
      if (publicUrl) {
        setVisibility('public');
        setShareExpiresAt(publicExpiresAt);
        setPublicShareUrl(publicUrl);
      }
      setUploadPercent(100);
      await chrome.storage.local.set({
        [PENDING_SHARE_KEY]: { shareUrl: newShareUrl, recordingId: backendId, videoUrl },
        [SHARE_VISIBILITY_KEY]: {
          recordingId,
          backendId,
          project,
          visibility: publicUrl ? 'public' : 'private',
          shareExpiresAt: publicExpiresAt,
          publicShareUrl: publicUrl,
        } satisfies ShareVisibilityState,
      });
      // Uploaded successfully — reclaim the local disk copy (OPFS/IDB).
      void deleteRecordingBlob(recordingId);
      // It stays in the Drafts list, just promoted to "saved" (Download/Copy
      // Link instead of Save/Download) rather than disappearing from it.
      void promoteDraftToSaved(recordingId, {
        title: title || data.title,
        backendRecordId: backendId,
        shareUrl: finalLink,
        videoUrl,
        isPublic: createPublic,
      });
      return finalLink;
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
      return null;
    } finally {
      setIsSaving(false);
      setSaveStage('idle');
    }
  }, [
    data,
    recordingId,
    title,
    isSaving,
    shareUrl,
    selectedProjectName,
    assignedProjects,
    getExportBlob,
    uploadVideoFile,
    trimStart,
    trimEnd,
    videoDuration,
    tags,
    description,
    visibility,
    pendingShareMinutes,
    mintShareToken,
    derivedThumbnail,
  ]);

  // Header "Save & Copy Link": saves the recording first if it isn't saved yet,
  // then copies the resulting link — one click does both.
  const handleSaveAndCopyLink = useCallback(async () => {
    if (isSaving) return;
    let link = visibility === 'public' && publicShareUrl ? publicShareUrl : shareUrl;
    if (!link) {
      link = await handleSave();
      if (!link) return; // save skipped or failed (e.g. no project selected)
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the record is still saved */
    }
  }, [isSaving, visibility, publicShareUrl, shareUrl, handleSave]);

  // Download the recording locally (applies the trim) without uploading — for
  // users who just want the file. Works whether or not they're signed in.
  const handleDownload = useCallback(async () => {
    if (!recordingId || isDownloading || isSaving) return;
    setIsDownloading(true);
    setUploadError(null);
    const safeTitle = (title || data?.title || 'recording')
      .replace(/[^a-z0-9-_ ]/gi, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60);
    const fileName = `${safeTitle || 'recording'}.webm`;
    try {
      // Prefer the local copy (applies the current trim). Once a recording is
      // uploaded its local blob is reclaimed, so fall back to fetching the
      // already-uploaded (already-trimmed) file from the server.
      let blob: Blob | null = null;
      try {
        blob = await getExportBlob();
      } catch {
        blob = null;
      }
      if (!blob && uploadedVideoUrl) {
        const r = await chrome.storage.local.get([AUTH_TOKENS_KEY]);
        const token = (r[AUTH_TOKENS_KEY] as { accessToken?: string } | undefined)?.accessToken;
        const res = await fetch(uploadedVideoUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`Could not fetch uploaded video (${res.status})`);
        blob = await res.blob();
      }
      if (!blob) throw new Error('Recording not found');
      downloadBlob(blob, fileName);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setIsDownloading(false);
    }
  }, [recordingId, isDownloading, isSaving, getExportBlob, title, data, uploadedVideoUrl]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
    } else {
      v.pause();
    }
  }, []);

  const handleSeek = useCallback((fraction: number) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    v.currentTime = fraction * v.duration;
  }, []);

  // When the recording carries no thumbnail of its own (e.g. a video uploaded
  // from local disk), grab a frame from the loaded <video> so the saved record
  // still gets one. Runs once: seek a touch past the start (frame 0 is often
  // black), then capture on the resulting `seeked`.
  const maybeStartThumbnailCapture = useCallback(() => {
    if (thumbCaptureStartedRef.current) return;
    if (data?.thumbnailDataUrl || derivedThumbnail) return;
    const v = videoRef.current;
    if (!v) return;
    thumbCaptureStartedRef.current = true;
    try {
      v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
    } catch {
      /* seeking unsupported — capture attempt is skipped */
    }
  }, [data, derivedThumbnail]);

  const captureThumbnailFrame = useCallback(() => {
    if (!thumbCaptureStartedRef.current || derivedThumbnail || data?.thumbnailDataUrl) return;
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    try {
      const canvas = document.createElement('canvas');
      const width = Math.min(v.videoWidth, 640);
      const height = Math.round(width * (v.videoHeight / v.videoWidth)) || 360;
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(v, 0, 0, width, height);
      setDerivedThumbnail(canvas.toDataURL('image/jpeg', 0.7));
    } catch {
      /* canvas draw failed (e.g. not decodable yet) — leave without a thumbnail */
    }
  }, [data, derivedThumbnail]);

  const totalDur = videoDuration || (data?.duration ?? 0);

  return (
    <div
      style={{
        height: '100vh',
        overflow: 'hidden',
        background: '#0a0a0f',
        fontFamily: "'Inter', -apple-system, sans-serif",
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          background: 'rgba(10,10,15,0.95)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '30px',
              height: '30px',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            <img
              src={chrome.runtime.getURL('icons/bestq-logo.png')}
              alt="BestQ"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </div>
          <span style={{ fontSize: '15px', fontWeight: 700, color: 'white' }}>BestQ</span>
          {INSTANCE_LABEL && (
            <motion.span
              title={INSTANCE_LABEL}
              initial={{ scale: 0, rotate: -25, opacity: 0 }}
              animate={{
                scale: 1,
                rotate: 0,
                opacity: 1,
                boxShadow: IS_PRODUCTION
                  ? [
                      '0 0 0px 0px rgba(16,185,129,0.55)',
                      '0 0 10px 1px rgba(16,185,129,0.55)',
                      '0 0 0px 0px rgba(16,185,129,0.55)',
                    ]
                  : [
                      '0 0 0px 0px rgba(245,158,11,0.55)',
                      '0 0 10px 1px rgba(245,158,11,0.55)',
                      '0 0 0px 0px rgba(245,158,11,0.55)',
                    ],
              }}
              transition={{
                scale: { type: 'spring', stiffness: 400, damping: 16 },
                rotate: { type: 'spring', stiffness: 400, damping: 16 },
                opacity: { duration: 0.2 },
                boxShadow: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
              }}
              whileHover={{ scale: 1.12, rotate: 6 }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '28px',
                height: '28px',
                borderRadius: '8px',
                border: `1px solid ${IS_PRODUCTION ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.4)'}`,
                background: IS_PRODUCTION ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                color: IS_PRODUCTION ? '#34d399' : '#fbbf24',
              }}
            >
              {IS_PRODUCTION ? <ShieldCheck size={16} /> : <FlaskConical size={16} />}
            </motion.span>
          )}
        </div>

        {/* ── Project selector (center) ── */}
        <ProjectSelector
          projects={assignedProjects}
          selected={selectedProjectName}
          onSelect={setSelectedProjectName}
          onOpen={refreshProjects}
          disabled={!!shareUrl || isSaving}
        />

        {/* Independent audio mutes. The mic is recorded to its own track, so each
            source can be silenced separately. Kept in the header so they don't take
            vertical space away from the video preview, and grouped in their own tight
            cluster so the header's wider gap doesn't push them apart. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <AudioMuteButton
            muted={muteMic}
            onToggle={() => setMuteMic((v) => !v)}
            label="Mic"
            available={!!micUrl}
            unavailableHint="No separate mic track in this recording (recorded before mic/system audio were split, or no mic was used)"
            icon={
              muteMic ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                  <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                </svg>
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                </svg>
              )
            }
          />

          <AudioMuteButton
            muted={muteSystemAudio}
            onToggle={() => setMuteSystemAudio((v) => !v)}
            label="Audio"
            available
            icon={
              muteSystemAudio ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )
            }
          />
        </div>

        <VisibilityControl
          isSaved={!!backendRecordId}
          visibility={visibility}
          shareExpiresAt={shareExpiresAt}
          isBusy={isVisibilityBusy}
          error={visibilityError}
          onSetPublic={choosePublicVisibility}
          onSetPrivate={setPrivateVisibility}
        />

        {(() => {
          // Enabled once signed in with a recording loaded — clicking saves (if
          // needed) then copies. Only disabled while a save is mid-flight or the
          // user isn't signed in / the recording hasn't loaded yet.
          const canSaveCopy = isAuthenticated && !!data && !isSaving;
          return (
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => void handleSaveAndCopyLink()}
              disabled={!canSaveCopy}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 18px',
                borderRadius: '10px',
                background: canSaveCopy
                  ? 'linear-gradient(135deg,#8b5cf6,#7c3aed)'
                  : 'rgba(139,92,246,0.2)',
                border: canSaveCopy ? 'none' : '1px solid rgba(139,92,246,0.3)',
                // "Saving…" is active status, not a disabled state — keep it readable
                // even though the button is disabled while the save is in flight.
                color: canSaveCopy ? 'white' : isSaving ? '#c4b5fd' : 'rgba(139,92,246,0.6)',
                fontSize: '13px',
                fontWeight: 700,
                cursor: canSaveCopy ? 'pointer' : 'not-allowed',
                boxShadow: canSaveCopy ? '0 4px 20px rgba(139,92,246,0.35)' : 'none',
                transition: 'all 0.2s',
              }}
            >
              {copied ? <Check size={14} /> : <Link2 size={14} />}
              {copied
                ? 'Copied!'
                : isSaving
                  ? 'Saving…'
                  : shareUrl
                    ? 'Copy Link'
                    : 'Save & Copy Link'}
            </motion.button>
          );
        })()}
      </div>

      {/* ── Body ── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: '1fr 420px',
          gap: '20px',
          padding: '20px 24px 24px',
          // No max-width cap: the body fills the editor window instead of being
          // centred inside it, which previously left a wide dead margin on both
          // sides at the current window size. The right column stays fixed, so the
          // extra width all goes to the video preview.
          width: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        {/* ── Left: Player + Trim + Fields ── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            overflowY: 'auto',
            minHeight: 0,
            paddingRight: '4px',
          }}
        >
          {/* Video player */}
          <div
            style={{
              position: 'relative',
              background: '#000',
              borderRadius: '16px',
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              aspectRatio: '16/9',
              // Without this the flex column shrinks the player to a thin strip as
              // soon as the fields below need room — the aspect ratio alone doesn't
              // hold its height. Let the column scroll instead of crushing the video.
              flexShrink: 0,
            }}
          >
            {videoUrl ? (
              <>
                <video
                  ref={videoRef}
                  src={videoUrl}
                  // Preview what the saved file will sound like. The video's own
                  // track now carries system/tab audio only — the mic plays from
                  // the sibling <audio> below, so each mutes independently.
                  muted={muteSystemAudio}
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                  onTimeUpdate={() => {
                    setCurrentTime(videoRef.current?.currentTime ?? 0);
                    // Nudge the mic back in step if it drifts (seek, stall, etc.).
                    const mic = micAudioRef.current;
                    const vid = videoRef.current;
                    if (mic && vid && Math.abs(mic.currentTime - vid.currentTime) > 0.3) {
                      mic.currentTime = vid.currentTime;
                    }
                  }}
                  onLoadedData={maybeStartThumbnailCapture}
                  onSeeked={() => {
                    captureThumbnailFrame();
                    const mic = micAudioRef.current;
                    if (mic && videoRef.current) mic.currentTime = videoRef.current.currentTime;
                  }}
                  onDurationChange={() => {
                    const d = videoRef.current?.duration ?? 0;
                    if (isFinite(d) && d > 0) setVideoDuration(d);
                  }}
                  onPlay={() => {
                    setIsPlaying(true);
                    const mic = micAudioRef.current;
                    if (mic && videoRef.current) {
                      mic.currentTime = videoRef.current.currentTime;
                      void mic.play().catch(() => {});
                    }
                  }}
                  onPause={() => {
                    setIsPlaying(false);
                    micAudioRef.current?.pause();
                  }}
                  onEnded={() => {
                    setIsPlaying(false);
                    micAudioRef.current?.pause();
                  }}
                  onClick={togglePlay}
                />
                {micUrl ? (
                  <audio ref={micAudioRef} src={micUrl} muted={muteMic} preload="auto" />
                ) : null}
              </>
            ) : data?.thumbnailDataUrl ? (
              <img
                src={data.thumbnailDataUrl}
                alt="thumbnail"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '12px',
                  background:
                    'radial-gradient(ellipse at center, rgba(139,92,246,0.15) 0%, transparent 70%)',
                }}
              >
                <motion.div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '50%',
                    background: 'rgba(239,68,68,0.15)',
                    border: '2px solid rgba(239,68,68,0.6)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  animate={{ scale: [1, 1.08, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <div
                    style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '50%',
                      background: '#ef4444',
                    }}
                  />
                </motion.div>
                <p style={{ color: 'rgba(148,163,184,0.7)', fontSize: '13px' }}>
                  Processing recording…
                </p>
              </div>
            )}

            {/* Play overlay (when video loaded but paused) */}
            {videoUrl && !isPlaying && (
              <div
                onClick={togglePlay}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  background: 'rgba(0,0,0,0.25)',
                }}
              >
                <div
                  style={{
                    width: '52px',
                    height: '52px',
                    borderRadius: '50%',
                    background: 'rgba(139,92,246,0.9)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 20px rgba(139,92,246,0.5)',
                  }}
                >
                  <Play size={22} fill="white" style={{ marginLeft: '2px' }} />
                </div>
              </div>
            )}

            {/* Duration badge */}
            <div
              style={{
                position: 'absolute',
                bottom: '10px',
                right: '10px',
                background: 'rgba(0,0,0,0.75)',
                backdropFilter: 'blur(8px)',
                borderRadius: '8px',
                padding: '3px 8px',
                fontSize: '13px',
                fontWeight: 700,
                color: 'white',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatDur(totalDur)}
            </div>
          </div>

          {/* Playback controls bar */}
          <div
            style={{
              height: '36px',
              background: '#0d0d14',
              borderRadius: '10px',
              border: '1px solid rgba(255,255,255,0.07)',
              display: 'flex',
              alignItems: 'center',
              padding: '0 12px',
              gap: '10px',
            }}
          >
            <button
              onClick={togglePlay}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(148,163,184,0.8)',
                cursor: videoUrl ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                padding: '2px',
                opacity: videoUrl ? 1 : 0.4,
              }}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <span
              style={{
                fontSize: '12px',
                color: 'rgba(148,163,184,0.6)',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {formatDur(currentTime)} / {formatDur(totalDur)}
            </span>
            {/* Seekbar */}
            <SeekBar
              current={videoDuration > 0 ? currentTime / videoDuration : 0}
              onSeek={handleSeek}
              disabled={!videoUrl}
            />
            <button
              onClick={() => {
                if (videoRef.current) videoRef.current.currentTime = 0;
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(148,163,184,0.6)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <RotateCcw size={12} />
            </button>
            <button
              onClick={() => videoRef.current?.requestFullscreen()}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(148,163,184,0.6)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Maximize2 size={12} />
            </button>
          </div>

          {/* Trim bar */}
          <TrimBar
            duration={totalDur}
            trimStart={trimStart}
            trimEnd={trimEnd}
            playhead={videoDuration > 0 ? currentTime / videoDuration : 0}
            onTrimChange={(start, end) => {
              setTrimStart(start);
              setTrimEnd(end);
            }}
            onSeek={handleSeek}
          />

          {/* Meta badges */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <Chip>{formatDur(totalDur)}</Chip>
            <Chip>{formatBytes(data?.blobSize ?? 0)}</Chip>
            {data?.consoleLogs?.length ? <Chip>{data.consoleLogs.length} logs</Chip> : null}
            {data?.networkCaptures?.length ? (
              <Chip>{data.networkCaptures.length} requests</Chip>
            ) : null}
            {data?.visitedUrls?.length ? <Chip>{data.visitedUrls.length} links</Chip> : null}
          </div>

          {/* Title */}
          <FieldGroup label="TITLE">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`Recording — ${new Date().toLocaleString()}`}
              style={{
                width: '100%',
                padding: '10px 14px',
                background: '#111118',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                color: 'white',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.15s',
                fontFamily: 'inherit',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(139,92,246,0.5)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
              }}
            />
          </FieldGroup>

          {/* Description */}
          <FieldGroup label="DESCRIPTION">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
              maxLength={DESCRIPTION_MAX}
              placeholder="Write a description or @ to mention…"
              rows={3}
              style={{
                width: '100%',
                padding: '10px 14px',
                background: '#111118',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                color: 'white',
                fontSize: '14px',
                outline: 'none',
                resize: 'vertical',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                lineHeight: 1.5,
                transition: 'border-color 0.15s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(139,92,246,0.5)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
              }}
            />
            <span
              style={{
                alignSelf: 'flex-end',
                fontSize: '11px',
                color: description.length >= DESCRIPTION_MAX ? '#fbbf24' : 'rgba(148,163,184,0.45)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {description.length}/{DESCRIPTION_MAX}
            </span>
          </FieldGroup>

          {/* Tags */}
          <TagsInput tags={tags} onChange={setTags} max={25} />
        </div>

        {/* ── Right: Logs panel ── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: '#0d0d14',
            borderRadius: '16px',
            border: '1px solid rgba(255,255,255,0.08)',
            overflow: 'hidden',
            minHeight: 0,
            height: '100%',
          }}
        >
          {/* Tab bar */}
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
              padding: '0 4px',
            }}
          >
            {(['console', 'network', 'links', 'info'] as LogTab[]).map((tab) => {
              const count =
                tab === 'console'
                  ? (data?.consoleLogs?.length ?? 0)
                  : tab === 'network'
                    ? (data?.networkCaptures?.length ?? 0)
                    : tab === 'links'
                      ? (data?.visitedUrls?.length ?? 0)
                      : 0;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    flex: 1,
                    height: '40px',
                    background: 'none',
                    border: 'none',
                    borderBottom: activeTab === tab ? '2px solid #8b5cf6' : '2px solid transparent',
                    color: activeTab === tab ? '#a78bfa' : 'rgba(148,163,184,0.6)',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                    transition: 'color 0.15s',
                    fontFamily: 'inherit',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                  }}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {count > 0 && (
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: '10px',
                        background:
                          activeTab === tab ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.08)',
                        color: activeTab === tab ? '#a78bfa' : 'rgba(148,163,184,0.5)',
                      }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Log entries */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 0' }}>
            <AnimatePresence mode="wait">
              {activeTab === 'console' && (
                <motion.div
                  key="console"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                >
                  {data?.consoleLogs && data.consoleLogs.length > 0 ? (
                    data.consoleLogs.map((log, i) => (
                      <LogRow
                        key={i}
                        time={formatTime(log.timestamp)}
                        level={log.level}
                        message={log.message}
                      />
                    ))
                  ) : (
                    <EmptyLogs label="No console logs captured" />
                  )}
                </motion.div>
              )}
              {activeTab === 'network' && (
                <motion.div
                  key="network"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                >
                  {data?.networkCaptures && data.networkCaptures.length > 0 ? (
                    data.networkCaptures.map((req, i) => <NetworkRow key={i} req={req} />)
                  ) : (
                    <EmptyLogs label="No network requests captured" />
                  )}
                </motion.div>
              )}
              {activeTab === 'links' && (
                <motion.div
                  key="links"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                >
                  {data?.visitedUrls && data.visitedUrls.length > 0 ? (
                    data.visitedUrls.map((entry, i) => <UrlRow key={i} entry={entry} />)
                  ) : (
                    <EmptyLogs label="No URLs captured for this recording" />
                  )}
                </motion.div>
              )}
              {activeTab === 'info' && (
                <motion.div
                  key="info"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  style={{
                    padding: '12px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <InfoRow label="Duration" value={formatDur(totalDur)} />
                  <InfoRow label="File size" value={formatBytes(data?.blobSize ?? 0)} />
                  <InfoRow label="Recorded at" value={new Date().toLocaleString()} />
                  <InfoRow
                    label="Status"
                    value={
                      shareUrl
                        ? 'Uploaded'
                        : isSaving
                          ? `Uploading (${uploadPercent}%)`
                          : 'Ready to save'
                    }
                  />
                  <InfoRow label="Console logs" value={String(data?.consoleLogs?.length ?? 0)} />
                  <InfoRow
                    label="Network requests"
                    value={String(data?.networkCaptures?.length ?? 0)}
                  />
                  <InfoRow label="URLs visited" value={String(data?.visitedUrls?.length ?? 0)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Auth banner */}
          <AnimatePresence>
            {!isAuthenticated && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                style={{
                  margin: '12px',
                  padding: '14px 16px',
                  borderRadius: '12px',
                  background: 'rgba(245,158,11,0.1)',
                  border: '1px solid rgba(245,158,11,0.3)',
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}
                >
                  <Lock size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
                  <span style={{ fontSize: '13px', fontWeight: 700, color: '#f59e0b' }}>
                    Sign in to upload
                  </span>
                </div>
                <p
                  style={{
                    fontSize: '12px',
                    color: 'rgba(245,158,11,0.8)',
                    marginBottom: '12px',
                    lineHeight: 1.5,
                  }}
                >
                  Your recording is saved locally. Sign in to the extension and it will upload
                  automatically.
                </p>
                <button
                  onClick={handleOpenSignIn}
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '8px',
                    background: '#f59e0b',
                    border: 'none',
                    color: 'white',
                    fontSize: '13px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    fontFamily: 'inherit',
                  }}
                >
                  <LogIn size={13} />
                  Open Extension to Sign In
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Upload progress bar (visible while saving) */}
          {isSaving && (
            <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}
              >
                <span
                  style={{ fontSize: '11px', color: 'rgba(226,232,240,0.85)', fontWeight: 600 }}
                >
                  {saveStage === 'trimming' ? 'TRIMMING' : 'UPLOADING'}
                </span>
                <span style={{ fontSize: '11px', color: '#8b5cf6', fontWeight: 700 }}>
                  {uploadPercent}%
                </span>
              </div>
              <div
                style={{
                  height: '4px',
                  background: 'rgba(255,255,255,0.08)',
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <motion.div
                  style={{
                    height: '100%',
                    background: 'linear-gradient(90deg,#8b5cf6,#7c3aed)',
                    borderRadius: '2px',
                  }}
                  animate={{ width: `${uploadPercent}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
            </div>
          )}

          {/* Upload error */}
          {uploadError && (
            <div
              style={{
                margin: '0 12px 0',
                padding: '10px 14px',
                borderRadius: '10px',
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.25)',
                fontSize: '12px',
                color: '#f87171',
                lineHeight: 1.4,
              }}
            >
              {uploadError}
            </div>
          )}

          {/* Action buttons: primary (Save / Uploading / Copy Link / Sign in) + Download */}
          <div
            style={{
              padding: '12px 16px',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              display: 'flex',
              gap: '8px',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {shareUrl ? (
                /* ── Upload done: copy link ── */
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={() => void handleCopyLink()}
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
                    border: 'none',
                    color: 'white',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    boxShadow: '0 4px 20px rgba(139,92,246,0.3)',
                    transition: 'all 0.2s',
                    fontFamily: 'inherit',
                  }}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Copied!' : 'Copy Link'}
                </motion.button>
              ) : isSaving ? (
                /* ── Saving in progress ── */
                <div
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '12px',
                    background: 'rgba(139,92,246,0.15)',
                    border: '1px solid rgba(139,92,246,0.3)',
                    color: '#c4b5fd',
                    fontSize: '14px',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                  }}
                >
                  <motion.div
                    style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      border: '2px solid rgba(139,92,246,0.4)',
                      borderTopColor: '#8b5cf6',
                    }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                  />
                  {saveStage === 'trimming' ? 'Trimming' : 'Uploading'} {uploadPercent}%…
                </div>
              ) : isAuthenticated ? (
                /* ── Ready to save ── */
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={() => void handleSave()}
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
                    border: 'none',
                    color: 'white',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    boxShadow: '0 4px 20px rgba(139,92,246,0.3)',
                    transition: 'all 0.2s',
                    fontFamily: 'inherit',
                  }}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                  Save Recording
                </motion.button>
              ) : (
                /* ── Not signed in ── */
                <div
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '12px',
                    background: 'rgba(139,92,246,0.08)',
                    border: '1px solid rgba(139,92,246,0.2)',
                    color: 'rgba(139,92,246,0.4)',
                    fontSize: '14px',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    cursor: 'not-allowed',
                  }}
                >
                  <Lock size={14} /> Sign in to Save
                </div>
              )}
            </div>

            {/* Download locally — available whenever the video is loaded (no upload,
                no sign-in required). Applies the trim like Save does. */}
            {videoUrl && (
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => void handleDownload()}
                disabled={isSaving || isDownloading}
                title="Download recording to this computer"
                style={{
                  flexShrink: 0,
                  padding: '12px 14px',
                  borderRadius: '12px',
                  background: '#14141c',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: 700,
                  cursor: isSaving || isDownloading ? 'not-allowed' : 'pointer',
                  opacity: isSaving || isDownloading ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '7px',
                  fontFamily: 'inherit',
                }}
              >
                {isDownloading ? (
                  <motion.div
                    style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: 'white',
                    }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                  />
                ) : (
                  <Download size={16} />
                )}
              </motion.button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SeekBar ──────────────────────────────────────────────────────────────────

function SeekBar({
  current,
  onSeek,
  disabled,
}: {
  current: number;
  onSeek: (f: number) => void;
  disabled: boolean;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(f);
  };
  return (
    <div
      ref={barRef}
      onClick={handleClick}
      style={{
        flex: 1,
        height: '4px',
        background: 'rgba(255,255,255,0.1)',
        borderRadius: '2px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          height: '100%',
          width: `${current * 100}%`,
          background: '#8b5cf6',
          borderRadius: '2px',
          transition: 'width 0.1s linear',
        }}
      />
      {!disabled && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: `${current * 100}%`,
            transform: 'translate(-50%, -50%)',
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: '#8b5cf6',
            boxShadow: '0 0 0 2px rgba(139,92,246,0.4)',
          }}
        />
      )}
    </div>
  );
}

// ─── TrimBar ──────────────────────────────────────────────────────────────────

function TrimBar({
  duration,
  trimStart,
  trimEnd,
  playhead,
  onTrimChange,
  onSeek,
}: {
  duration: number;
  trimStart: number;
  trimEnd: number;
  playhead: number;
  onTrimChange: (start: number, end: number) => void;
  onSeek: (fraction: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'start' | 'end' | 'seek' | null>(null);

  const clamp = (v: number) => Math.max(0, Math.min(1, v));

  const getFraction = (clientX: number) => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width);
  };

  const onMouseDown = (handle: 'start' | 'end' | 'seek') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = handle;
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const f = getFraction(e.clientX);
      if (dragging.current === 'start') {
        onTrimChange(Math.min(f, trimEnd - 0.02), trimEnd);
      } else if (dragging.current === 'end') {
        onTrimChange(trimStart, Math.max(f, trimStart + 0.02));
      } else if (dragging.current === 'seek') {
        onSeek(f);
      }
    };
    const onUp = () => {
      dragging.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [trimStart, trimEnd, onTrimChange, onSeek]);

  const formatMs = (frac: number) => formatDur(frac * duration);

  return (
    <div
      style={{
        background: '#0d0d14',
        borderRadius: '12px',
        border: '1px solid rgba(255,255,255,0.07)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Scissors size={12} style={{ color: '#a78bfa' }} />
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: 'rgba(148,163,184,0.7)',
              letterSpacing: '0.6px',
            }}
          >
            TRIM
          </span>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <span
            style={{
              fontSize: '11px',
              color: 'rgba(148,163,184,0.5)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatMs(trimStart)} – {formatMs(trimEnd)}
          </span>
          <span
            style={{
              fontSize: '11px',
              color: '#a78bfa',
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatMs(trimEnd - trimStart)} selected
          </span>
        </div>
      </div>

      {/* Track */}
      <div
        ref={barRef}
        onMouseDown={onMouseDown('seek')}
        style={{
          position: 'relative',
          height: '32px',
          borderRadius: '6px',
          background: 'rgba(255,255,255,0.05)',
          cursor: 'crosshair',
          userSelect: 'none',
        }}
      >
        {/* Full timeline ticks */}
        {[0.25, 0.5, 0.75].map((f) => (
          <div
            key={f}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${f * 100}%`,
              width: '1px',
              background: 'rgba(255,255,255,0.06)',
            }}
          />
        ))}

        {/* Dimmed regions outside trim */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${trimStart * 100}%`,
            background: 'rgba(0,0,0,0.5)',
            borderRadius: '6px 0 0 6px',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            right: 0,
            width: `${(1 - trimEnd) * 100}%`,
            background: 'rgba(0,0,0,0.5)',
            borderRadius: '0 6px 6px 0',
          }}
        />

        {/* Active region */}
        <div
          style={{
            position: 'absolute',
            top: '4px',
            bottom: '4px',
            left: `${trimStart * 100}%`,
            width: `${(trimEnd - trimStart) * 100}%`,
            background: 'rgba(139,92,246,0.2)',
            border: '1px solid rgba(139,92,246,0.5)',
            borderRadius: '3px',
          }}
        />

        {/* Start handle */}
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            onMouseDown('start')(e);
          }}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${trimStart * 100}%`,
            width: '10px',
            transform: 'translateX(-50%)',
            cursor: 'ew-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2,
          }}
        >
          <div
            style={{
              width: '6px',
              height: '28px',
              background: '#8b5cf6',
              borderRadius: '3px',
              boxShadow: '0 0 0 2px rgba(139,92,246,0.4)',
            }}
          />
        </div>

        {/* End handle */}
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            onMouseDown('end')(e);
          }}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${trimEnd * 100}%`,
            width: '10px',
            transform: 'translateX(-50%)',
            cursor: 'ew-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2,
          }}
        >
          <div
            style={{
              width: '6px',
              height: '28px',
              background: '#8b5cf6',
              borderRadius: '3px',
              boxShadow: '0 0 0 2px rgba(139,92,246,0.4)',
            }}
          />
        </div>

        {/* Playhead */}
        <div
          style={{
            position: 'absolute',
            top: '-4px',
            bottom: '-4px',
            left: `${playhead * 100}%`,
            width: '2px',
            background: '#ef4444',
            borderRadius: '1px',
            pointerEvents: 'none',
            zIndex: 3,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '4px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '8px',
              height: '8px',
              background: '#ef4444',
              borderRadius: '50%',
            }}
          />
        </div>

        {/* Time labels */}
        <div
          style={{
            position: 'absolute',
            bottom: '-18px',
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'space-between',
            pointerEvents: 'none',
          }}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span
              key={f}
              style={{
                fontSize: '9px',
                color: 'rgba(148,163,184,0.35)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatMs(f)}
            </span>
          ))}
        </div>
      </div>

      {/* Spacer for time labels */}
      <div style={{ height: '8px' }} />
    </div>
  );
}

// ─── Visibility Control (Private / Public share toggle) ───────────────────────

function VisibilityControl({
  isSaved,
  visibility,
  shareExpiresAt,
  isBusy,
  error,
  onSetPublic,
  onSetPrivate,
}: {
  // Whether the recording has a backend recordId yet. The control is always
  // clickable either way — a pre-save "Public" choice is just remembered and
  // applied automatically the moment the save completes (see
  // choosePublicVisibility / the materialize effect in EditorApp).
  isSaved: boolean;
  visibility: Visibility;
  shareExpiresAt: number | null;
  isBusy: boolean;
  error: string | null;
  onSetPublic: (minutes: number) => void;
  onSetPrivate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCustom(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const isPublic = visibility === 'public';

  const applyCustom = () => {
    if (!customValue) return;
    const target = new Date(customValue).getTime();
    const minutes = Math.ceil((target - Date.now()) / 60000);
    if (!Number.isFinite(minutes) || minutes < 1) return;
    onSetPublic(minutes);
    setOpen(false);
    setShowCustom(false);
  };

  // datetime-local min= needs local time with no seconds/zone, e.g. "2026-07-23T14:30"
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          padding: '8px 14px',
          borderRadius: '10px',
          background: isPublic ? 'rgba(245,158,11,0.12)' : '#111118',
          border: `1px solid ${isPublic ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.1)'}`,
          color: isPublic ? '#fbbf24' : 'rgba(203,213,225,0.8)',
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'all 0.15s',
        }}
      >
        {isPublic ? <Globe size={14} /> : <Lock size={14} />}
        {isPublic ? 'Public' : 'Private'}
        <ChevronDown
          size={13}
          style={{
            color: 'inherit',
            opacity: 0.6,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 0,
              width: '260px',
              background: '#14141c',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '12px',
              boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
              zIndex: 50,
              padding: '10px',
            }}
          >
            {/* Current status */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 8px 10px',
                fontSize: '11px',
                color: isPublic ? '#fbbf24' : 'rgba(148,163,184,0.6)',
                fontWeight: 600,
              }}
            >
              <Clock size={11} />
              {!isSaved
                ? isPublic
                  ? 'Public link will be created once you save'
                  : 'Save the recording to enable sharing'
                : isPublic
                  ? formatRemaining(shareExpiresAt)
                  : 'Only people with project access can view'}
            </div>

            {/* Private option */}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => {
                onSetPrivate();
                setOpen(false);
                setShowCustom(false);
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                borderRadius: '8px',
                background: !isPublic ? 'rgba(139,92,246,0.18)' : 'transparent',
                border: 'none',
                color: !isPublic ? '#c4b5fd' : 'rgba(203,213,225,0.85)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: isBusy ? 'default' : 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <Lock size={14} />
              Private
            </button>

            <div
              style={{
                margin: '8px 4px 6px',
                fontSize: '10px',
                fontWeight: 700,
                color: 'rgba(148,163,184,0.45)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Make public for
            </div>

            {SHARE_DURATION_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={isBusy}
                onClick={() => {
                  onSetPublic(preset.minutes);
                  setOpen(false);
                  setShowCustom(false);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(203,213,225,0.85)',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: isBusy ? 'default' : 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <Globe size={14} style={{ color: '#fbbf24' }} />
                {preset.label}
              </button>
            ))}

            {/* Custom date & time */}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setShowCustom((v) => !v)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                borderRadius: '8px',
                background: showCustom ? 'rgba(255,255,255,0.05)' : 'transparent',
                border: 'none',
                color: 'rgba(203,213,225,0.85)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: isBusy ? 'default' : 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <Globe size={14} style={{ color: '#fbbf24' }} />
              Custom date &amp; time…
            </button>

            {showCustom && (
              <div
                style={{
                  padding: '8px 10px 4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <input
                  type="datetime-local"
                  value={customValue}
                  min={nowLocal}
                  onChange={(e) => setCustomValue(e.target.value)}
                  style={{
                    padding: '7px 9px',
                    borderRadius: '8px',
                    background: '#0d0d14',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'white',
                    fontSize: '12px',
                    fontFamily: 'inherit',
                    colorScheme: 'dark',
                  }}
                />
                <button
                  type="button"
                  disabled={isBusy || !customValue}
                  onClick={applyCustom}
                  style={{
                    padding: '7px',
                    borderRadius: '8px',
                    background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
                    border: 'none',
                    color: 'white',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: !customValue || isBusy ? 'not-allowed' : 'pointer',
                    opacity: !customValue || isBusy ? 0.5 : 1,
                    fontFamily: 'inherit',
                  }}
                >
                  Set expiry
                </button>
              </div>
            )}

            {error && (
              <div
                style={{
                  margin: '8px 4px 2px',
                  fontSize: '11px',
                  color: '#f87171',
                  lineHeight: 1.4,
                }}
              >
                {error}
              </div>
            )}

            <div
              style={{
                margin: '10px 4px 2px',
                fontSize: '10px',
                color: 'rgba(148,163,184,0.4)',
                lineHeight: 1.4,
              }}
            >
              Links already shared stay accessible until they individually expire, even after
              switching back to Private.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Project Selector ──────────────────────────────────────────────────────────

function ProjectSelector({
  projects,
  selected,
  onSelect,
  onOpen,
  disabled,
}: {
  projects: Record<string, AssignedProjectInfo> | null;
  selected: string | null;
  onSelect: (name: string) => void;
  onOpen?: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const entries = projects ? Object.entries(projects) : [];
  const hasProjects = entries.length > 0;

  // Refresh the project list from the API each time the dropdown opens.
  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v;
      if (next) onOpen?.();
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const needsSelection = !selected;

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: '260px' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={toggleOpen}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderRadius: '10px',
          background: '#111118',
          border: `1px solid ${needsSelection ? 'rgba(245,158,11,0.5)' : 'rgba(139,92,246,0.4)'}`,
          color: selected ? 'white' : 'rgba(148,163,184,0.7)',
          fontSize: '13px',
          fontWeight: 600,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          fontFamily: 'inherit',
          transition: 'border-color 0.15s',
        }}
      >
        <FolderOpen size={15} style={{ color: '#a78bfa', flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            textAlign: 'left',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {selected ?? (hasProjects ? 'Select a project' : 'No projects available')}
        </span>
        <ChevronDown
          size={15}
          style={{
            color: 'rgba(148,163,184,0.6)',
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      {/* Warning when nothing is selected */}
      {needsSelection && hasProjects && !disabled && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 5px)',
            left: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontSize: '11px',
            color: '#fbbf24',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          <AlertCircle size={12} />
          Please select a project
        </div>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              maxHeight: '280px',
              overflowY: 'auto',
              background: '#14141c',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '12px',
              boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
              zIndex: 50,
              padding: '6px',
            }}
          >
            {!hasProjects && (
              <div
                style={{
                  padding: '12px 10px',
                  fontSize: '12px',
                  color: 'rgba(148,163,184,0.6)',
                  textAlign: 'center',
                }}
              >
                No projects available
              </div>
            )}
            {entries.map(([name, info]) => {
              const isSel = name === selected;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    onSelect(name);
                    setOpen(false);
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '9px 10px',
                    borderRadius: '8px',
                    background: isSel ? 'rgba(139,92,246,0.18)' : 'transparent',
                    border: 'none',
                    color: isSel ? '#c4b5fd' : 'rgba(203,213,225,0.85)',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSel) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSel) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {name}
                  </span>
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 700,
                      letterSpacing: '0.4px',
                      padding: '2px 6px',
                      borderRadius: '6px',
                      background: 'rgba(255,255,255,0.07)',
                      color: 'rgba(148,163,184,0.7)',
                      flexShrink: 0,
                    }}
                  >
                    {info.projectRole?.replace(/_/g, ' ') ?? ''}
                  </span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

/**
 * Header toggle for muting one audio source in the exported recording.
 * `available: false` renders it disabled — used when a recording has no separate
 * mic track to mute (older recordings, or none captured).
 */
function AudioMuteButton({
  muted,
  onToggle,
  label,
  icon,
  available,
  unavailableHint,
}: {
  muted: boolean;
  onToggle: () => void;
  label: string;
  icon: React.ReactNode;
  available: boolean;
  unavailableHint?: string;
}) {
  const title = !available
    ? (unavailableHint ?? `No ${label.toLowerCase()} track in this recording`)
    : muted
      ? `${label} will be removed from the saved recording — click to keep it`
      : `Mute ${label.toLowerCase()} in the saved recording`;
  return (
    <motion.button
      whileTap={available ? { scale: 0.96 } : undefined}
      onClick={available ? onToggle : undefined}
      disabled={!available}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 10px',
        borderRadius: '10px',
        border:
          muted && available
            ? '1px solid rgba(239,68,68,0.45)'
            : '1px solid rgba(255,255,255,0.12)',
        background: muted && available ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)',
        color: !available ? 'rgba(148,163,184,0.45)' : muted ? '#fca5a5' : '#d1c4e9',
        fontSize: '13px',
        fontWeight: 600,
        cursor: available ? 'pointer' : 'not-allowed',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
        opacity: available ? 1 : 0.6,
      }}
    >
      {icon}
      {label}
    </motion.button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        padding: '4px 10px',
        borderRadius: '20px',
        background: 'rgba(255,255,255,0.07)',
        border: '1px solid rgba(255,255,255,0.1)',
        fontSize: '12px',
        fontWeight: 600,
        color: 'rgba(203,213,225,0.8)',
      }}
    >
      {children}
    </span>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label
        style={{
          fontSize: '11px',
          fontWeight: 700,
          color: 'rgba(148,163,184,0.6)',
          letterSpacing: '0.8px',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Tags Input ────────────────────────────────────────────────────────────────
// A chip-style tag editor. The API field is the comma-joined string; each
// individual tag is capped at `max` chars (the counter + shake enforce it).
// Chips cycle through a small palette and spring in/out for a lively feel.

const TAG_COLORS = [
  { bg: 'rgba(139,92,246,0.18)', border: 'rgba(139,92,246,0.55)', text: '#c4b5fd' },
  { bg: 'rgba(236,72,153,0.18)', border: 'rgba(236,72,153,0.55)', text: '#f9a8d4' },
  { bg: 'rgba(34,197,94,0.18)', border: 'rgba(34,197,94,0.55)', text: '#86efac' },
  { bg: 'rgba(59,130,246,0.18)', border: 'rgba(59,130,246,0.55)', text: '#93c5fd' },
  { bg: 'rgba(245,158,11,0.18)', border: 'rgba(245,158,11,0.55)', text: '#fcd34d' },
  { bg: 'rgba(20,184,166,0.18)', border: 'rgba(20,184,166,0.55)', text: '#5eead4' },
];

function TagsInput({
  tags,
  onChange,
  max,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  max: number;
}) {
  const [input, setInput] = useState('');
  const [shake, setShake] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Counter tracks the length of the tag currently being typed — each tag is
  // capped at `max` chars (there's no cap on how many tags you add).
  const used = input.length;
  const remaining = max - used;

  const bump = () => {
    setShake(true);
    window.setTimeout(() => setShake(false), 420);
  };

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/,/g, '').toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setInput('');
      return;
    }
    if (t.length > max) {
      bump();
      return;
    }
    onChange([...tags, t]);
    setInput('');
  };

  const removeTag = (t: string) => onChange(tags.filter((x) => x !== t));

  const counterColor =
    remaining <= 0 ? '#f87171' : remaining <= 6 ? '#fbbf24' : 'rgba(148,163,184,0.55)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {/* Label + live counter */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.8px',
            color: 'rgba(148,163,184,0.6)',
          }}
        >
          <Tag size={11} style={{ color: '#a78bfa' }} />
          TAGS
        </span>
        <motion.span
          key={remaining}
          initial={{ scale: 1.3, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 20 }}
          style={{
            fontSize: '10px',
            fontWeight: 700,
            color: counterColor,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {used}/{max}
        </motion.span>
      </div>

      {/* Chip container */}
      <motion.div
        animate={shake ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.42 }}
        onClick={() => inputRef.current?.focus()}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '6px',
          minHeight: '44px',
          padding: '8px 10px',
          borderRadius: '10px',
          background: '#111118',
          border: `1px solid ${
            shake
              ? 'rgba(239,68,68,0.6)'
              : focused
                ? 'rgba(139,92,246,0.5)'
                : 'rgba(255,255,255,0.1)'
          }`,
          transition: 'border-color 0.15s',
          cursor: 'text',
        }}
      >
        <AnimatePresence initial={false}>
          {tags.map((tag, i) => {
            const c = TAG_COLORS[i % TAG_COLORS.length]!;
            return (
              <motion.span
                key={tag}
                layout
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '3px 5px 3px 9px',
                  borderRadius: '7px',
                  background: c.bg,
                  border: `1px solid ${c.border}`,
                  color: c.text,
                  fontSize: '12px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {tag}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTag(tag);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    background: 'transparent',
                    color: c.text,
                    cursor: 'pointer',
                    padding: 0,
                    opacity: 0.75,
                  }}
                >
                  <X size={12} />
                </button>
              </motion.span>
            );
          })}
        </AnimatePresence>

        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (input.trim()) addTag(input);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addTag(input);
            } else if (e.key === 'Backspace' && !input && tags.length) {
              removeTag(tags[tags.length - 1]!);
            }
          }}
          placeholder={tags.length ? 'Add…' : 'e.g. smoke, payment, regression'}
          maxLength={max}
          style={{
            flex: 1,
            minWidth: '90px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'white',
            fontSize: '13px',
            fontFamily: 'inherit',
          }}
        />
      </motion.div>

      <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.45)' }}>
        Press Enter or comma to add · {max} chars per tag
      </span>
    </div>
  );
}

const LEVEL_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  log: { bg: 'rgba(34,197,94,0.15)', color: '#4ade80', label: 'LOG' },
  info: { bg: 'rgba(59,130,246,0.15)', color: '#60a5fa', label: 'INFO' },
  warn: { bg: 'rgba(245,158,11,0.15)', color: '#fbbf24', label: 'WARN' },
  error: { bg: 'rgba(239,68,68,0.15)', color: '#f87171', label: 'ERROR' },
  debug: { bg: 'rgba(148,163,184,0.12)', color: 'rgba(148,163,184,0.7)', label: 'DBG' },
};

function LogRow({ time, level, message }: { time: string; level: string; message: string }) {
  const style = LEVEL_STYLES[level] ?? LEVEL_STYLES.log!;
  return (
    <div
      style={{
        display: 'flex',
        gap: '10px',
        padding: '6px 16px',
        fontSize: '12px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        alignItems: 'flex-start',
      }}
    >
      <span
        style={{
          color: 'rgba(148,163,184,0.5)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
          marginTop: '1px',
        }}
      >
        {time}
      </span>
      <span
        style={{
          padding: '1px 6px',
          borderRadius: '4px',
          background: style.bg,
          color: style.color,
          fontSize: '10px',
          fontWeight: 700,
          flexShrink: 0,
          letterSpacing: '0.5px',
        }}
      >
        {style.label}
      </span>
      <span
        style={{
          color: 'rgba(203,213,225,0.85)',
          flex: 1,
          lineHeight: 1.4,
          wordBreak: 'break-word',
        }}
      >
        {message}
      </span>
    </div>
  );
}

function HeaderList({ title, headers }: { title: string; headers?: Record<string, string> }) {
  const entries = Object.entries(headers ?? {});
  return (
    <div style={{ marginBottom: '10px' }}>
      <div
        style={{
          fontSize: '10px',
          fontWeight: 700,
          color: 'rgba(148,163,184,0.6)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '4px',
        }}
      >
        {title}
      </div>
      {entries.length === 0 ? (
        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.35)' }}>No headers captured</div>
      ) : (
        entries.map(([name, value]) => (
          <div key={name} style={{ fontSize: '11px', lineHeight: 1.6, wordBreak: 'break-all' }}>
            <span style={{ color: '#a78bfa', fontWeight: 600 }}>{name}:</span>{' '}
            <span style={{ color: 'rgba(203,213,225,0.75)' }}>{value}</span>
          </div>
        ))
      )}
    </div>
  );
}

function NetworkRow({ req }: { req: NetworkCapture }) {
  const [expanded, setExpanded] = useState(false);
  const isFailed = req.failed || req.status === 0;
  const statusColor = isFailed
    ? '#f87171'
    : req.status >= 500
      ? '#f87171'
      : req.status >= 400
        ? '#fbbf24'
        : req.status >= 200
          ? '#4ade80'
          : 'rgba(148,163,184,0.6)';
  const path = req.url.replace(/^https?:\/\/[^/]+/, '') || req.url;
  const shortUrl = path.length > 45 ? path.slice(0, 45) + '…' : path;
  const statusLabel = isFailed && req.status === 0 ? 'ERR' : req.status || '—';
  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          gap: '8px',
          padding: '6px 16px',
          fontSize: '12px',
          alignItems: 'center',
          background: isFailed ? 'rgba(239,68,68,0.04)' : 'transparent',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            color: 'rgba(148,163,184,0.4)',
            flexShrink: 0,
            fontSize: '9px',
            width: '10px',
          }}
        >
          {expanded ? '▼' : '▶'}
        </span>
        <span
          style={{
            color: 'rgba(148,163,184,0.5)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {formatTime(req.timestamp)}
        </span>
        <span
          style={{
            padding: '1px 6px',
            borderRadius: '4px',
            background: 'rgba(139,92,246,0.15)',
            color: '#a78bfa',
            fontSize: '10px',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {req.method}
        </span>
        <span style={{ color: statusColor, fontWeight: 700, flexShrink: 0, minWidth: '28px' }}>
          {statusLabel}
        </span>
        <span
          style={{
            color: 'rgba(203,213,225,0.7)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={req.url}
        >
          {shortUrl}
        </span>
        {req.mimeType && (
          <span style={{ color: 'rgba(148,163,184,0.35)', flexShrink: 0, fontSize: '10px' }}>
            {req.mimeType.split(';')[0]}
          </span>
        )}
        <span style={{ color: 'rgba(148,163,184,0.4)', flexShrink: 0 }}>
          {req.duration > 0 ? `${req.duration}ms` : '—'}
        </span>
      </div>
      {expanded && (
        <div
          style={{
            padding: '10px 16px 12px 34px',
            background: 'rgba(15,23,42,0.4)',
            borderTop: '1px solid rgba(255,255,255,0.03)',
          }}
        >
          <div
            style={{
              fontSize: '11px',
              color: 'rgba(203,213,225,0.6)',
              wordBreak: 'break-all',
              marginBottom: '10px',
            }}
          >
            {req.url}
          </div>
          <HeaderList title="Request Headers" headers={req.requestHeaders} />
          <HeaderList title="Response Headers" headers={req.responseHeaders} />
          {req.requestBody && (
            <div style={{ marginBottom: '10px' }}>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: 'rgba(148,163,184,0.6)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: '4px',
                }}
              >
                Request Body
              </div>
              <pre
                style={{
                  fontSize: '11px',
                  color: 'rgba(203,213,225,0.75)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  maxHeight: '160px',
                  overflow: 'auto',
                  margin: 0,
                }}
              >
                {req.requestBody}
              </pre>
            </div>
          )}
          {req.responseBody && (
            <div>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: 'rgba(148,163,184,0.6)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: '4px',
                }}
              >
                Response{req.responseBodyTruncated ? ' (truncated)' : ''}
              </div>
              <pre
                style={{
                  fontSize: '11px',
                  color: 'rgba(203,213,225,0.75)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  maxHeight: '240px',
                  overflow: 'auto',
                  margin: 0,
                }}
              >
                {req.responseBody}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UrlRow({ entry }: { entry: VisitedUrl }) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const openUrl = () => {
    chrome.tabs.create({ url: entry.url });
  };
  return (
    <div
      onClick={openUrl}
      title={entry.url}
      style={{
        display: 'flex',
        gap: '10px',
        padding: '8px 16px',
        fontSize: '12px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        alignItems: 'center',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(139,92,246,0.06)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span
        style={{
          color: 'rgba(148,163,184,0.5)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatTime(entry.timestamp)}
      </span>
      {entry.favIconUrl && !faviconFailed ? (
        <img
          src={entry.favIconUrl}
          alt=""
          onError={() => setFaviconFailed(true)}
          style={{ width: '14px', height: '14px', flexShrink: 0, borderRadius: '3px' }}
        />
      ) : (
        <Globe size={14} style={{ color: 'rgba(148,163,184,0.4)', flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' }}>
        {entry.title && (
          <span
            style={{
              color: 'rgba(226,232,240,0.85)',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.title}
          </span>
        )}
        <span
          style={{
            color: '#a78bfa',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textDecoration: 'underline',
          }}
        >
          {entry.url}
        </span>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '12px', color: 'rgba(148,163,184,0.5)' }}>{label}</span>
      <span style={{ fontSize: '12px', color: 'rgba(203,213,225,0.85)', fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );
}

function EmptyLogs({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        gap: '8px',
      }}
    >
      <span style={{ fontSize: '28px', opacity: 0.3 }}>—</span>
      <span style={{ fontSize: '12px', color: 'rgba(148,163,184,0.4)', textAlign: 'center' }}>
        {label}
      </span>
    </div>
  );
}
