import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, Play, Pause, Maximize2, RotateCcw, Link2, Lock, LogIn } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EditorData {
  recordingId: string;
  thumbnailDataUrl: string | null;
  duration: number;
  blobSize: number;
  title: string;
  consoleLogs: ConsoleLog[];
  networkCaptures: NetworkCapture[];
}

interface ConsoleLog {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
  url: string;
}

interface NetworkCapture {
  url: string;
  method: string;
  status: number;
  duration: number;
  timestamp: number;
  size: number;
}

type LogTab = 'console' | 'network' | 'info' | 'actions';

// ─── Storage key (mirrors types/index.ts) ────────────────────────────────────
const EDITOR_DATA_KEY = 'st_editor_data';
const PENDING_SHARE_KEY = 'st_pending_share';
const AUTH_TOKENS_KEY = 'st_auth_tokens';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDur(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
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
  const [isUploading, setIsUploading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<LogTab>('console');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── Load editor data from storage ──────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const result = await chrome.storage.local.get([
        EDITOR_DATA_KEY,
        PENDING_SHARE_KEY,
        AUTH_TOKENS_KEY,
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
        setIsUploading(false);
        setUploadPercent(100);
      }

      const tokens = result[AUTH_TOKENS_KEY] as { accessToken?: string } | undefined;
      setIsAuthenticated(!!tokens?.accessToken);
    };
    void load();
  }, [recordingId]);

  // ── Listen for upload progress / completion ─────────────────────────────────
  useEffect(() => {
    const listener = (message: { type: string; payload?: unknown }) => {
      if (message.type === 'UPLOAD_PROGRESS') {
        const p = message.payload as { percentComplete: number };
        setUploadPercent(p.percentComplete ?? 0);
        setIsUploading(true);
      }
      if (message.type === 'UPLOAD_COMPLETE') {
        const p = message.payload as { shareUrl: string };
        setShareUrl(p.shareUrl);
        setIsUploading(false);
        setUploadPercent(100);
      }
      if (message.type === 'OAUTH_LOGIN_COMPLETE') {
        setIsAuthenticated(true);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── Poll for share URL if not yet received ──────────────────────────────────
  useEffect(() => {
    if (shareUrl) return;
    const id = setInterval(async () => {
      const result = await chrome.storage.local.get([PENDING_SHARE_KEY]);
      const pending = result[PENDING_SHARE_KEY] as
        | { shareUrl: string; recordingId: string }
        | undefined;
      if (pending?.shareUrl) {
        setShareUrl(pending.shareUrl);
        setIsUploading(false);
        setUploadPercent(100);
        clearInterval(id);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [shareUrl]);

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenSignIn = () => {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      void videoRef.current.play();
    }
    setIsPlaying((p) => !p);
  };

  const canCopy = !!shareUrl && isAuthenticated;

  return (
    <div
      style={{
        minHeight: '100vh',
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
        {/* Logo */}
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
        </div>

        {/* Save & Copy Link */}
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
          display: 'grid',
          gridTemplateColumns: '1fr 420px',
          gap: '20px',
          padding: '20px 24px 24px',
          maxWidth: '1200px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        {/* ── Left: Player + Fields ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Video / Thumbnail */}
          <div
            style={{
              position: 'relative',
              background: '#0d0d14',
              borderRadius: '16px',
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              aspectRatio: '16/9',
            }}
          >
            {data?.thumbnailDataUrl ? (
              <>
                <img
                  src={data.thumbnailDataUrl}
                  alt="Recording thumbnail"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                {/* Play overlay */}
                <div
                  onClick={togglePlay}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    background: 'rgba(0,0,0,0.3)',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.45)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.3)';
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
                  {formatDur(data?.duration ?? 0)}
                </div>
              </>
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
                <div style={{ position: 'relative' }}>
                  <motion.div
                    style={{
                      width: '56px',
                      height: '56px',
                      borderRadius: '50%',
                      border: '2px solid rgba(239,68,68,0.5)',
                      position: 'absolute',
                      top: '-6px',
                      left: '-6px',
                    }}
                    animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0, 0.5] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                  <div
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
                  >
                    <div
                      style={{
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: '#ef4444',
                      }}
                    />
                  </div>
                </div>
                <p style={{ color: 'rgba(148,163,184,0.7)', fontSize: '13px' }}>
                  Processing recording…
                </p>
              </div>
            )}
          </div>

          {/* Timeline placeholder */}
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
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: '2px',
              }}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <span
              style={{
                fontSize: '12px',
                color: 'rgba(148,163,184,0.6)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              00:00 / {formatDur(data?.duration ?? 0)}
            </span>
            <div
              style={{
                flex: 1,
                height: '3px',
                background: 'rgba(255,255,255,0.08)',
                borderRadius: '2px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{ height: '100%', width: '0%', background: '#8b5cf6', borderRadius: '2px' }}
              />
            </div>
            <button
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(148,163,184,0.6)',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 600,
              }}
            >
              1×
            </button>
            <button
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

          {/* Meta badges */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <Chip>{formatDur(data?.duration ?? 0)}</Chip>
            <Chip>{formatBytes(data?.blobSize ?? 0)}</Chip>
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
            {(['console', 'network', 'info', 'actions'] as LogTab[]).map((tab) => (
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
                }}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {/* Log entries */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
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
                  <InfoRow label="Duration" value={formatDur(data?.duration ?? 0)} />
                  <InfoRow label="File size" value={formatBytes(data?.blobSize ?? 0)} />
                  <InfoRow label="Recorded at" value={new Date().toLocaleString()} />
                  <InfoRow
                    label="Status"
                    value={isUploading ? `Uploading (${uploadPercent}%)` : 'Ready'}
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

          {/* Sign in to upload banner */}
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

          {/* Upload progress */}
          {isAuthenticated && isUploading && (
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

          {/* Save & Copy Link CTA */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => void handleCopyLink()}
              disabled={!canCopy}
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '12px',
                background: canCopy
                  ? 'linear-gradient(135deg,#8b5cf6,#7c3aed)'
                  : 'rgba(139,92,246,0.15)',
                border: canCopy ? 'none' : '1px solid rgba(139,92,246,0.3)',
                color: canCopy ? 'white' : 'rgba(139,92,246,0.5)',
                fontSize: '14px',
                fontWeight: 700,
                cursor: canCopy ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                boxShadow: canCopy ? '0 4px 20px rgba(139,92,246,0.3)' : 'none',
                transition: 'all 0.2s',
                fontFamily: 'inherit',
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {!canCopy && isUploading
                ? `Uploading ${uploadPercent}%…`
                : copied
                  ? 'Copied!'
                  : 'Save & Copy Link'}
            </motion.button>
          </div>
        </div>
      </div>
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
};

function LogRow({ time, level, message }: { time: string; level: string; message: string }) {
  const style = LEVEL_STYLES[level] ?? LEVEL_STYLES.log;
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
  const statusColor =
    req.status >= 500
      ? '#f87171'
      : req.status >= 400
        ? '#fbbf24'
        : req.status >= 200
          ? '#4ade80'
          : 'rgba(148,163,184,0.6)';

  const shortUrl =
    req.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 40) + (req.url.length > 60 ? '…' : '');

  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        padding: '6px 16px',
        fontSize: '12px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        alignItems: 'center',
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
      <span style={{ color: statusColor, fontWeight: 700, flexShrink: 0 }}>
        {req.status || '—'}
      </span>
      <span
        style={{
          color: 'rgba(203,213,225,0.7)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {shortUrl}
      </span>
      <span style={{ color: 'rgba(148,163,184,0.4)', flexShrink: 0 }}>{req.duration}ms</span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '12px', color: 'rgba(148,163,184,0.6)' }}>{label}</span>
      <span style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(203,213,225,0.9)' }}>
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
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 16px',
        color: 'rgba(148,163,184,0.4)',
        fontSize: '12px',
      }}
    >
      {label}
    </div>
  );
}

interface NetworkCapture {
  url: string;
  method: string;
  status: number;
  duration: number;
  timestamp: number;
  size: number;
}
