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
  Scissors,
  FolderOpen,
  ChevronDown,
  AlertCircle,
  ShieldCheck,
  FlaskConical,
} from 'lucide-react';
import { RP_HOST, API_BASE_URL as API_BASE, INSTANCE_LABEL, IS_PRODUCTION } from '@/config';

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
  source?: 'cdp' | 'injected';
}

interface AssignedProjectInfo {
  projectId: number;
  projectRole: string;
  entryType: string;
}

type LogTab = 'console' | 'network' | 'info' | 'actions';

// ─── Constants ────────────────────────────────────────────────────────────────
const EDITOR_DATA_KEY = 'st_editor_data';
const PENDING_SHARE_KEY = 'st_pending_share';
const AUTH_TOKENS_KEY = 'st_auth_tokens';
const AUTH_USER_KEY = 'st_auth_user';
const IDB_NAME = 'snaptrace-blobs';
const IDB_STORE = 'recordings';

function splitBlob(blob: Blob): Blob[] {
  const CHUNK_SIZE = 2 * 1024 * 1024;
  const parts: Blob[] = [];
  for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
    parts.push(blob.slice(offset, offset + CHUNK_SIZE));
  }
  return parts;
}

// ─── IDB helpers ─────────────────────────────────────────────────────────────

function openRecordingIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadBlobFromIDB(id: string): Promise<Blob | null> {
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
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<LogTab>('console');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(1); // 0–1 fractions of total duration
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null);
  const [assignedProjects, setAssignedProjects] = useState<Record<
    string,
    AssignedProjectInfo
  > | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── Load editor data + blob from IDB ───────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const result = await chrome.storage.local.get([
        EDITOR_DATA_KEY,
        PENDING_SHARE_KEY,
        AUTH_TOKENS_KEY,
        AUTH_USER_KEY,
      ]);

      const stored = result[EDITOR_DATA_KEY] as EditorData | undefined;
      if (stored) {
        setData(stored);
        setTitle(stored.title);
      }

      const pending = result[PENDING_SHARE_KEY] as
        | { shareUrl: string; recordingId: string }
        | undefined;
      if (pending?.shareUrl && (!recordingId || pending.recordingId === recordingId)) {
        setShareUrl(pending.shareUrl);
        setUploadPercent(100);
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
      const blob = await loadBlobFromIDB(recordingId);
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

  // ── Listen for auth changes ────────────────────────────────────────────────
  useEffect(() => {
    const listener = (message: { type: string }) => {
      if (message.type === 'OAUTH_LOGIN_COMPLETE') setIsAuthenticated(true);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenSignIn = () => chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });

  const handleSave = useCallback(async () => {
    if (!data || !recordingId || isSaving || shareUrl) return;

    // Check if a project is selected
    if (!selectedProjectName) {
      setUploadError('Please select a project to save your recording');
      return;
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
        return;
      }

      const blob = await loadBlobFromIDB(recordingId);
      if (!blob || blob.size === 0) throw new Error('Recording not found in local storage');

      const mime = blob.type || 'video/webm';
      const mimeBase = mime.split(';')[0] ?? 'video/webm';
      const ts = Date.now();
      const isoNow = new Date(ts).toISOString();
      const shareId = `share-${ts}`;

      // Use the selected project instead of fetching the first one
      const project = selectedProjectName;
      const projectId = assignedProjects?.[project]?.projectId ?? null;

      // Step 2: upload video file → get MinIO filename
      const videoFileName = await new Promise<string>((resolve, reject) => {
        const videoFile = new File([blob], `recording-${ts}.webm`, { type: mimeBase });
        const formData = new FormData();
        formData.append('file', videoFile);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/v1/${project}/files/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Accept', 'text/plain, application/json, */*');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadPercent(Math.round((e.loaded / e.total) * 80));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText.trim());
          else reject(new Error(`Video upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Network error during video upload'));
        xhr.send(formData);
      });

      // Step 3: upload HAR (network logs) → get MinIO filename
      setUploadPercent(82);
      let harFileName = '';
      try {
        const harData = {
          log: {
            version: '1.2',
            creator: { name: 'SnapTrace', version: '1.0' },
            entries: (data.networkCaptures ?? []).map((r) => ({
              startedDateTime: new Date(r.timestamp).toISOString(),
              time: r.duration,
              request: {
                method: r.method,
                url: r.url,
                headers: [],
                queryString: [],
                cookies: [],
                headersSize: -1,
                bodySize: -1,
              },
              response: {
                status: r.status,
                statusText: r.statusText ?? '',
                headers: [],
                content: { size: r.size, mimeType: r.mimeType ?? '' },
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

      // Step 5: create record with all fields
      setUploadPercent(92);
      const videoUrl = `${API_BASE}/v1/${project}/files/${videoFileName}`;
      const createRes = await fetch(`${API_BASE}/v1/${project}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: title || data.title,
          description: 'Recording captured with SnapTrace',
          type: 'video',
          mimeType: mimeBase,
          status: 'completed',
          userId,
          projectId: projectId !== null ? String(projectId) : '1',
          shareId,
          isPublic: false,
          allowDownload: true,
          viewCount: 0,
          url: videoUrl,
          thumbnailUrl: data.thumbnailDataUrl ?? null,
          duration: Math.round(data.duration ?? 0),
          networkLogs: harFileName || null,
          consoleLogs: logsFileName || null,
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

      // Step 6: open RP UI record page
      const newShareUrl = `${RP_HOST}/ui/#/${project}/records/${backendId}`;
      setShareUrl(newShareUrl);
      setUploadPercent(100);
      await chrome.storage.local.set({
        [PENDING_SHARE_KEY]: { shareUrl: newShareUrl, recordingId: backendId },
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsSaving(false);
    }
  }, [data, recordingId, title, isSaving, shareUrl, selectedProjectName, assignedProjects]);

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

  const canCopy = !!shareUrl;
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
              background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="3" fill="white" />
              <circle cx="7" cy="7" r="5.5" stroke="white" strokeWidth="1" strokeOpacity="0.5" />
            </svg>
          </div>
          <span style={{ fontSize: '15px', fontWeight: 700, color: 'white' }}>SnapTrace</span>
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
          disabled={!!shareUrl || isSaving}
        />

        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={() => void handleCopyLink()}
          disabled={!canCopy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 18px',
            borderRadius: '10px',
            background: canCopy
              ? 'linear-gradient(135deg,#8b5cf6,#7c3aed)'
              : 'rgba(139,92,246,0.2)',
            border: canCopy ? 'none' : '1px solid rgba(139,92,246,0.3)',
            color: canCopy ? 'white' : 'rgba(139,92,246,0.6)',
            fontSize: '13px',
            fontWeight: 700,
            cursor: canCopy ? 'pointer' : 'not-allowed',
            boxShadow: canCopy ? '0 4px 20px rgba(139,92,246,0.35)' : 'none',
            transition: 'all 0.2s',
          }}
        >
          {copied ? <Check size={14} /> : <Link2 size={14} />}
          {copied ? 'Copied!' : 'Save & Copy Link'}
        </motion.button>
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
          maxWidth: '1200px',
          width: '100%',
          margin: '0 auto',
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
            }}
          >
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
                onDurationChange={() => {
                  const d = videoRef.current?.duration ?? 0;
                  if (isFinite(d) && d > 0) setVideoDuration(d);
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onClick={togglePlay}
              />
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
              onChange={(e) => setDescription(e.target.value)}
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
          </FieldGroup>
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
            {(['console', 'network', 'info', 'actions'] as LogTab[]).map((tab) => {
              const count =
                tab === 'console'
                  ? (data?.consoleLogs?.length ?? 0)
                  : tab === 'network'
                    ? (data?.networkCaptures?.length ?? 0)
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
                </motion.div>
              )}
              {activeTab === 'actions' && (
                <motion.div
                  key="actions"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                >
                  <EmptyLogs label="No actions recorded" />
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
                <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.7)', fontWeight: 600 }}>
                  UPLOADING
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

          {/* Action button: Save → Uploading → Copy Link */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
              /* ── Uploading in progress ── */
              <div
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '12px',
                  background: 'rgba(139,92,246,0.15)',
                  border: '1px solid rgba(139,92,246,0.3)',
                  color: 'rgba(139,92,246,0.6)',
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
                Uploading {uploadPercent}%…
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

// ─── Project Selector ──────────────────────────────────────────────────────────

function ProjectSelector({
  projects,
  selected,
  onSelect,
  disabled,
}: {
  projects: Record<string, AssignedProjectInfo> | null;
  selected: string | null;
  onSelect: (name: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const entries = projects ? Object.entries(projects) : [];
  const hasProjects = entries.length > 0;

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
        disabled={disabled || !hasProjects}
        onClick={() => setOpen((v) => !v)}
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
          cursor: disabled || !hasProjects ? 'not-allowed' : 'pointer',
          opacity: disabled || !hasProjects ? 0.6 : 1,
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
        {open && hasProjects && (
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

function NetworkRow({ req }: { req: NetworkCapture }) {
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
    <div
      style={{
        display: 'flex',
        gap: '8px',
        padding: '6px 16px',
        fontSize: '12px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        alignItems: 'center',
        background: isFailed ? 'rgba(239,68,68,0.04)' : 'transparent',
      }}
    >
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
