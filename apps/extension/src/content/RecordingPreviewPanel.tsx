import { useState, useEffect } from 'react';

interface NetworkCapture {
  url: string;
  method: string;
  status: number;
  duration: number;
  timestamp: number;
  size: number;
}

interface Props {
  thumbnailDataUrl: string | null;
  duration: number;
  blobSize: number;
  shareUrl: string | null;
  uploadProgress: number;
  networkCaptures: NetworkCapture[];
  errorMessage?: string | null;
  onClose: () => void;
  onCopied: () => void;
  onSignIn?: () => void;
}

export function RecordingPreviewPanel({
  thumbnailDataUrl,
  duration,
  blobSize,
  shareUrl,
  uploadProgress,
  networkCaptures,
  errorMessage,
  onClose,
  onSignIn,
}: Props) {
  const [title, setTitle] = useState(
    `Recording – ${new Date().toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`,
  );
  const [description, setDescription] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [liveShareUrl, setLiveShareUrl] = useState<string | null>(shareUrl);
  const [liveProgress, setLiveProgress] = useState(uploadProgress);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setLiveShareUrl(shareUrl);
    setLiveProgress(uploadProgress);
  }, [shareUrl, uploadProgress]);

  useEffect(() => {
    // Animate in
    const t = setTimeout(() => setVisible(true), 30);
    return () => clearTimeout(t);
  }, []);

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 300);
  };

  const handleCreateAndCopy = async () => {
    if (!liveShareUrl) {
      setIsCreating(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(liveShareUrl);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2500);
    } catch {
      // Clipboard API blocked — use execCommand fallback
      const ta = document.createElement('textarea');
      ta.value = liveShareUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2500);
    }
  };

  const formatDur = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const formatBytes = (b: number) => {
    if (b === 0) return '';
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isError = liveProgress === -1 || !!errorMessage;
  const isAuthError = errorMessage?.includes('Not authenticated') ?? false;
  const isUploading = !isError && liveProgress >= 0 && liveProgress < 100;
  const canCopy = !!liveShareUrl && !isError;

  // Suppress unused variable warning — isCreating drives future UI state
  void isCreating;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: '380px',
        height: '100vh',
        background: '#0f1117',
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: '14px',
        color: '#e2e8f0',
        transform: visible ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        zIndex: 2147483647,
        boxShadow: '-8px 0 40px rgba(0,0,0,0.5)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 2L14 8L8 14L2 8L8 2Z" fill="white" fillOpacity="0.9" />
              <circle cx="8" cy="8" r="2.5" fill="white" />
            </svg>
          </div>
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#f1f5f9' }}>SnapTrace</span>
        </div>
        <button
          onClick={handleClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#64748b',
            padding: '4px',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
          }}
          title="Close"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {/* Thumbnail */}
        <div
          style={{
            width: '100%',
            aspectRatio: '16/9',
            borderRadius: '10px',
            overflow: 'hidden',
            background: '#1e2330',
            border: '1px solid rgba(255,255,255,0.07)',
            marginBottom: '14px',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {thumbnailDataUrl ? (
            <img
              src={thumbnailDataUrl}
              alt="Recording preview"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ textAlign: 'center', color: '#475569' }}>
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                style={{ marginBottom: '6px' }}
              >
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              <p style={{ fontSize: '11px', margin: 0 }}>Video preview</p>
            </div>
          )}
          {/* Duration badge */}
          {duration > 0 && (
            <div
              style={{
                position: 'absolute',
                bottom: '8px',
                right: '8px',
                background: 'rgba(0,0,0,0.75)',
                color: '#fff',
                fontSize: '11px',
                fontWeight: 600,
                padding: '2px 6px',
                borderRadius: '5px',
                fontFamily: 'monospace',
              }}
            >
              {formatDur(duration)}
            </div>
          )}
        </div>

        {/* Upload progress */}
        {isUploading && (
          <div style={{ marginBottom: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>Uploading…</span>
              <span style={{ fontSize: '11px', color: '#6366f1', fontWeight: 600 }}>
                {liveProgress}%
              </span>
            </div>
            <div
              style={{
                height: '4px',
                background: '#1e293b',
                borderRadius: '99px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: '99px',
                  background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                  width: `${liveProgress}%`,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        )}

        {/* Auth error — sign in prompt */}
        {isError && isAuthError && (
          <div
            style={{
              padding: '12px',
              borderRadius: '10px',
              marginBottom: '14px',
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.25)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fbbf24"
                strokeWidth="2"
                style={{ flexShrink: 0 }}
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#fcd34d' }}>
                Sign in to upload
              </span>
            </div>
            <p
              style={{ fontSize: '11px', color: '#d97706', margin: '0 0 10px 0', lineHeight: 1.5 }}
            >
              Your recording is saved locally. Sign in to the extension and it will upload
              automatically.
            </p>
            <button
              onClick={onSignIn}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'linear-gradient(135deg, #d97706, #b45309)',
                color: '#fff',
                border: 'none',
                borderRadius: '7px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'Inter, sans-serif',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              Open Extension to Sign In
            </button>
          </div>
        )}

        {/* Generic error state */}
        {isError && !isAuthError && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '8px',
              marginBottom: '14px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.25)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f87171"
              strokeWidth="2"
              style={{ flexShrink: 0, marginTop: '1px' }}
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span style={{ fontSize: '11px', color: '#fca5a5', lineHeight: 1.4 }}>
              {errorMessage ?? 'Upload failed. Check your connection and try again.'}
            </span>
          </div>
        )}

        {/* Meta badges */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' }}>
          {duration > 0 && (
            <span
              style={{
                padding: '3px 8px',
                borderRadius: '6px',
                background: 'rgba(99,102,241,0.12)',
                color: '#a5b4fc',
                fontSize: '11px',
                fontWeight: 500,
              }}
            >
              {formatDur(duration)}
            </span>
          )}
          {blobSize > 0 && (
            <span
              style={{
                padding: '3px 8px',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.05)',
                color: '#64748b',
                fontSize: '11px',
              }}
            >
              {formatBytes(blobSize)}
            </span>
          )}
          {networkCaptures.length > 0 && (
            <span
              style={{
                padding: '3px 8px',
                borderRadius: '6px',
                background: 'rgba(34,197,94,0.12)',
                color: '#86efac',
                fontSize: '11px',
                fontWeight: 500,
              }}
            >
              {networkCaptures.length} API calls
            </span>
          )}
        </div>

        {/* Title */}
        <div style={{ marginBottom: '12px' }}>
          <label
            style={{
              fontSize: '11px',
              color: '#64748b',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              display: 'block',
              marginBottom: '6px',
            }}
          >
            Title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Give your recording a title…"
            style={{
              width: '100%',
              padding: '9px 12px',
              background: '#1a1f2e',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#f1f5f9',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
              fontFamily: 'Inter, sans-serif',
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'rgba(99,102,241,0.5)';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'rgba(255,255,255,0.08)';
            }}
          />
        </div>

        {/* Description */}
        <div style={{ marginBottom: '16px' }}>
          <label
            style={{
              fontSize: '11px',
              color: '#64748b',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              display: 'block',
              marginBottom: '6px',
            }}
          >
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Write a description or @ to mention…"
            rows={3}
            style={{
              width: '100%',
              padding: '9px 12px',
              background: '#1a1f2e',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#f1f5f9',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
              resize: 'vertical',
              fontFamily: 'Inter, sans-serif',
              minHeight: '72px',
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'rgba(99,102,241,0.5)';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'rgba(255,255,255,0.08)';
            }}
          />
        </div>

        {/* Network captures preview */}
        {networkCaptures.length > 0 && (
          <div style={{ marginBottom: '14px' }}>
            <label
              style={{
                fontSize: '11px',
                color: '#64748b',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                display: 'block',
                marginBottom: '8px',
              }}
            >
              Network Captures ({networkCaptures.length})
            </label>
            <div
              style={{
                background: '#1a1f2e',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '8px',
                overflow: 'hidden',
                maxHeight: '160px',
                overflowY: 'auto',
              }}
            >
              {networkCaptures.slice(-10).map((cap, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '7px 12px',
                    borderBottom:
                      i < networkCaptures.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                  }}
                >
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      padding: '1px 5px',
                      borderRadius: '4px',
                      flexShrink: 0,
                      background:
                        cap.status >= 400 ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.12)',
                      color: cap.status >= 400 ? '#f87171' : '#86efac',
                    }}
                  >
                    {cap.status || 'ERR'}
                  </span>
                  <span
                    style={{ fontSize: '10px', fontWeight: 500, color: '#94a3b8', flexShrink: 0 }}
                  >
                    {cap.method}
                  </span>
                  <span
                    style={{
                      fontSize: '10px',
                      color: '#475569',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                    title={cap.url}
                  >
                    {cap.url.replace(/^https?:\/\//, '')}
                  </span>
                  <span style={{ fontSize: '10px', color: '#334155', flexShrink: 0 }}>
                    {cap.duration}ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Share URL (when ready) */}
        {liveShareUrl && (
          <div
            style={{
              padding: '10px 12px',
              background: 'rgba(99,102,241,0.08)',
              border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: '8px',
              marginBottom: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#818cf8"
              strokeWidth="2"
              style={{ flexShrink: 0 }}
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span
              style={{
                fontSize: '11px',
                color: '#94a3b8',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                fontFamily: 'monospace',
              }}
            >
              {liveShareUrl.replace(/^https?:\/\//, '')}
            </span>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          gap: '8px',
          flexShrink: 0,
          background: '#0f1117',
        }}
      >
        {/* Create & Copy Link */}
        <button
          onClick={() => void handleCreateAndCopy()}
          disabled={!canCopy}
          style={{
            flex: 1,
            padding: '10px 16px',
            background: canCopy
              ? isCopied
                ? '#16a34a'
                : 'linear-gradient(135deg, #4f46e5, #7c3aed)'
              : '#1e293b',
            color: canCopy ? '#fff' : '#475569',
            border: 'none',
            borderRadius: '9px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: canCopy ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            transition: 'all 0.2s',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          {isCopied ? (
            <>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Copied!
            </>
          ) : isUploading ? (
            <>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ animation: 'spin 1s linear infinite' }}
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              {liveProgress}%…
            </>
          ) : (
            <>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              Create & copy link
            </>
          )}
        </button>

        {/* Open in browser */}
        {liveShareUrl && (
          <button
            onClick={() => window.open(liveShareUrl!, '_blank')}
            title="Open in browser"
            style={{
              padding: '10px 12px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '9px',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input:focus, textarea:focus { outline: none; }
      `}</style>
    </div>
  );
}
