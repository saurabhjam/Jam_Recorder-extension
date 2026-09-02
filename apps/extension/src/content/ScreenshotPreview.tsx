import { useState, useCallback } from 'react';

interface ScreenshotPreviewProps {
  dataUrl: string;
  warnings?: string[];
  onClose: () => void;
}

export function ScreenshotPreview({ dataUrl, warnings, onClose }: ScreenshotPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [warningsExpanded, setWarningsExpanded] = useState(false);
  const hasWarnings = Boolean(warnings && warnings.length > 0);

  const handleCopy = useCallback(async () => {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopyError(true);
      setTimeout(() => setCopyError(false), 2200);
    }
  }, [dataUrl]);

  const handleDownload = useCallback(() => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `screenshot-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [dataUrl]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        background: 'rgba(5, 3, 15, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          background: 'linear-gradient(160deg, #16103a 0%, #0f0b24 100%)',
          border: '1px solid rgba(139,92,246,0.25)',
          borderRadius: 16,
          padding: 16,
          maxWidth: 'min(880px, 92vw)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 32px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(139,92,246,0.1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Camera icon */}
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: 'rgba(139,92,246,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#a78bfa"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
            <span style={{ color: '#e2d9f3', fontWeight: 700, fontSize: 13 }}>Screenshot</span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              color: '#9ca3af',
              cursor: 'pointer',
              padding: '4px 10px',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.12)';
              (e.currentTarget as HTMLButtonElement).style.color = '#e2d9f3';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
              (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af';
            }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
              <path
                d="M1 1l10 10M11 1L1 11"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            Close
          </button>
        </div>

        {/* Capture warnings — surfaces a partial/incomplete full-page capture
            directly, so it's visible without opening devtools. */}
        {hasWarnings && (
          <div
            style={{
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.35)',
              borderRadius: 10,
              padding: '10px 12px',
              fontSize: 12,
              color: '#fca5a5',
            }}
          >
            <button
              onClick={() => setWarningsExpanded((v) => !v)}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span>⚠</span>
              This capture may be incomplete — {warnings!.length} issue
              {warnings!.length === 1 ? '' : 's'} occurred ({warningsExpanded ? 'hide' : 'show'}{' '}
              details)
            </button>
            {warningsExpanded && (
              <ul
                style={{
                  margin: '8px 0 0',
                  paddingLeft: 18,
                  color: '#fecaca',
                  maxHeight: 160,
                  overflow: 'auto',
                }}
              >
                {warnings!.map((w, i) => (
                  <li key={i} style={{ marginBottom: 4, wordBreak: 'break-word' }}>
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Image */}
        <div
          style={{
            overflow: 'auto',
            maxHeight: 'calc(90vh - 130px)',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(0,0,0,0.3)',
            lineHeight: 0,
          }}
        >
          <img
            src={dataUrl}
            alt="Screenshot"
            style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
          />
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => void handleCopy()}
            style={{
              flex: 1,
              padding: '10px 0',
              background: copied
                ? 'rgba(34,197,94,0.18)'
                : copyError
                  ? 'rgba(239,68,68,0.18)'
                  : 'rgba(255,255,255,0.07)',
              border: `1px solid ${copied ? 'rgba(34,197,94,0.4)' : copyError ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.12)'}`,
              borderRadius: 10,
              color: copied ? '#4ade80' : copyError ? '#f87171' : '#d1c4e9',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              transition: 'all 0.15s',
              fontFamily: 'inherit',
            }}
          >
            {copied ? (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Copied!
              </>
            ) : copyError ? (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12" y2="16" />
                </svg>
                Copy failed
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
                  strokeLinecap="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Copy Image
              </>
            )}
          </button>

          <button
            onClick={handleDownload}
            style={{
              flex: 1,
              padding: '10px 0',
              background: 'linear-gradient(135deg, rgba(109,40,217,0.85), rgba(124,58,237,0.85))',
              border: '1px solid rgba(139,92,246,0.4)',
              borderRadius: 10,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              transition: 'all 0.15s',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                'linear-gradient(135deg, rgba(109,40,217,1), rgba(124,58,237,1))';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                'linear-gradient(135deg, rgba(109,40,217,0.85), rgba(124,58,237,0.85))';
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
