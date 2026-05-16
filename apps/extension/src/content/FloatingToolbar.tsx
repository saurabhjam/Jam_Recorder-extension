import { useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { formatDuration } from '@/utils';

interface FloatingToolbarProps {
  recordingId: string;
  duration: number;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onScreenshot: () => void;
  onAnnotate: (imageUrl: string) => void;
}

export function FloatingToolbar({ duration, onStop, onPause, onResume }: FloatingToolbarProps) {
  const [isPaused, setIsPaused] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const constraintsRef = useRef<HTMLDivElement>(null);

  const handlePauseResume = useCallback(() => {
    if (isPaused) onResume();
    else onPause();
    setIsPaused((p) => !p);
  }, [isPaused, onPause, onResume]);

  const handleStop = useCallback(() => {
    setIsStopping(true);
    onStop();
  }, [onStop]);

  return (
    <>
      <style>{`
        @keyframes st-dot-pulse {
          0%,100% { opacity:1; transform:scale(1); }
          50% { opacity:0.45; transform:scale(1.4); }
        }
      `}</style>

      {/* Full-page invisible drag boundary */}
      <div
        ref={constraintsRef}
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 2147483646,
          visibility: 'hidden',
        }}
      />

      <motion.div
        drag
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={constraintsRef}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={() => setIsDragging(false)}
        initial={{ opacity: 0, scale: 0.85, y: 0 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        style={{
          position: 'fixed',
          bottom: '32px',
          left: '50%',
          translateX: '-50%',
          zIndex: 2147483647,
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
          pointerEvents: 'all',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 10px',
            borderRadius: '100px',
            background: 'rgba(9,9,13,0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(139,92,246,0.12)',
            whiteSpace: 'nowrap',
          }}
        >
          {/* Recording dot */}
          <span
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              flexShrink: 0,
              background: isPaused ? '#f59e0b' : '#ef4444',
              boxShadow: isPaused ? '0 0 6px rgba(245,158,11,0.7)' : '0 0 6px rgba(239,68,68,0.7)',
              animation: isPaused ? 'none' : 'st-dot-pulse 1.4s ease-in-out infinite',
            }}
          />

          {/* Timer */}
          <span
            style={{
              fontFamily: "'Inter', ui-monospace, monospace",
              fontSize: '13px',
              fontWeight: 700,
              color: 'white',
              letterSpacing: '0.5px',
              minWidth: '48px',
              textAlign: 'center',
            }}
          >
            {formatDuration(duration)}
          </span>

          {/* Divider */}
          <span
            style={{
              width: '1px',
              height: '16px',
              background: 'rgba(255,255,255,0.12)',
              flexShrink: 0,
            }}
          />

          {/* Pause / Resume */}
          <PillButton
            onClick={handlePauseResume}
            title={isPaused ? 'Resume' : 'Pause'}
            color="rgba(255,255,255,0.1)"
            hoverColor="rgba(255,255,255,0.18)"
          >
            {isPaused ? <PlaySvg /> : <PauseSvg />}
          </PillButton>

          {/* Stop */}
          <PillButton
            onClick={handleStop}
            title="Stop Recording"
            color="rgba(239,68,68,0.2)"
            hoverColor="rgba(239,68,68,0.35)"
            disabled={isStopping}
          >
            <StopSvg />
          </PillButton>
        </div>
      </motion.div>
    </>
  );
}

// ─── Pill Button ──────────────────────────────────────────────────────────────

interface PillButtonProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  color: string;
  hoverColor: string;
  disabled?: boolean;
}

function PillButton({ onClick, title, children, color, hoverColor, disabled }: PillButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <motion.button
      whileTap={{ scale: 0.88 }}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '28px',
        height: '28px',
        borderRadius: '50%',
        border: 'none',
        background: hovered ? hoverColor : color,
        color: 'white',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s',
        padding: 0,
      }}
    >
      {children}
    </motion.button>
  );
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function PauseSvg() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
      <rect x="5" y="3" width="5" height="18" rx="1.5" />
      <rect x="14" y="3" width="5" height="18" rx="1.5" />
    </svg>
  );
}

function PlaySvg() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
      <polygon points="6,3 20,12 6,21" />
    </svg>
  );
}

function StopSvg() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="#ef4444">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
    </svg>
  );
}
