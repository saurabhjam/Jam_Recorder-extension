import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import {
  Square,
  Pause,
  Play,
  Camera,
  Edit3,
  Mic,
  MicOff,
  Video,
  VideoOff,
  ChevronDown,
  ChevronUp,
  GripVertical,
} from 'lucide-react';
import { formatDuration } from '@/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FloatingToolbarProps {
  recordingId: string;
  duration: number;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onScreenshot: () => void;
  onAnnotate: (imageUrl: string) => void;
}

// ─── FloatingToolbar ──────────────────────────────────────────────────────────

export function FloatingToolbar({
  duration,
  onStop,
  onPause,
  onResume,
  onScreenshot,
}: FloatingToolbarProps) {
  const [isPaused, setIsPaused] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isWebcamOn, setIsWebcamOn] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const dragControls = useDragControls();
  const containerRef = useRef<HTMLDivElement>(null);

  // Drag bounds (keep toolbar within viewport)
  const dragConstraints = {
    top: -window.innerHeight + 120,
    left: -window.innerWidth + 180,
    right: 0,
    bottom: 0,
  };

  const handlePauseResume = useCallback(() => {
    if (isPaused) {
      onResume();
    } else {
      onPause();
    }
    setIsPaused((p) => !p);
  }, [isPaused, onPause, onResume]);

  const handleStop = useCallback(() => {
    onStop();
  }, [onStop]);

  const handleScreenshot = useCallback(() => {
    onScreenshot();
  }, [onScreenshot]);

  // Pulse animation for recording dot
  useEffect(() => {
    // Intentionally empty – pulse handled via CSS animation
  }, []);

  return (
    <motion.div
      ref={containerRef}
      drag
      dragControls={dragControls}
      dragMomentum={false}
      dragConstraints={dragConstraints}
      dragElastic={0.05}
      onDragStart={() => setIsDragging(true)}
      onDragEnd={() => setIsDragging(false)}
      initial={{ opacity: 0, scale: 0.8, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: 20 }}
      transition={{ type: 'spring', stiffness: 350, damping: 25 }}
      className="floating-toolbar"
      style={{ cursor: isDragging ? 'grabbing' : 'default' }}
    >
      <div
        style={{
          background: 'rgba(9, 9, 11, 0.95)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '20px',
          boxShadow: '0 16px 64px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.15)',
          minWidth: isMinimized ? '160px' : '200px',
          overflow: 'hidden',
          userSelect: 'none',
        }}
      >
        {/* Drag Handle + Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 12px 8px',
            borderBottom: isMinimized ? 'none' : '1px solid rgba(255,255,255,0.06)',
            cursor: 'grab',
          }}
          onPointerDown={(e) => dragControls.start(e)}
        >
          {/* Recording indicator */}
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: isPaused ? '#f59e0b' : '#ef4444',
              boxShadow: isPaused ? '0 0 8px rgba(245,158,11,0.6)' : '0 0 8px rgba(239,68,68,0.6)',
              animation: isPaused ? 'none' : 'jam-pulse 1.5s ease-in-out infinite',
              flexShrink: 0,
            }}
          />

          {/* Timer */}
          <span
            style={{
              fontFamily: "'Inter', monospace",
              fontSize: '14px',
              fontWeight: '700',
              color: 'white',
              letterSpacing: '-0.5px',
              flex: 1,
            }}
          >
            {formatDuration(duration)}
          </span>

          <GripVertical size={14} style={{ color: 'rgba(148,163,184,0.4)', flexShrink: 0 }} />

          {/* Minimize toggle */}
          <button
            onClick={() => setIsMinimized((m) => !m)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '22px',
              height: '22px',
              borderRadius: '6px',
              border: 'none',
              background: 'rgba(255,255,255,0.08)',
              color: 'rgba(148,163,184,0.8)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {isMinimized ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>

        {/* Controls */}
        <AnimatePresence>
          {!isMinimized && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              style={{ overflow: 'hidden' }}
            >
              {/* Primary controls */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '10px 12px',
                }}
              >
                {/* Pause/Resume */}
                <ToolbarButton
                  onClick={handlePauseResume}
                  title={isPaused ? 'Resume' : 'Pause'}
                  active={false}
                  color={isPaused ? '#f59e0b' : undefined}
                >
                  {isPaused ? <Play size={14} /> : <Pause size={14} />}
                </ToolbarButton>

                {/* Stop */}
                <ToolbarButton onClick={handleStop} title="Stop Recording" color="#ef4444" danger>
                  <Square size={14} />
                </ToolbarButton>

                {/* Screenshot */}
                <ToolbarButton onClick={handleScreenshot} title="Screenshot">
                  <Camera size={14} />
                </ToolbarButton>
              </div>

              {/* Secondary controls */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '0 12px 10px',
                }}
              >
                {/* Mic */}
                <ToolbarButton
                  onClick={() => setIsMicMuted((m) => !m)}
                  title={isMicMuted ? 'Unmute Mic' : 'Mute Mic'}
                  active={isMicMuted}
                  activeColor="rgba(239,68,68,0.2)"
                >
                  {isMicMuted ? (
                    <MicOff size={13} style={{ color: '#ef4444' }} />
                  ) : (
                    <Mic size={13} />
                  )}
                </ToolbarButton>

                {/* Webcam */}
                <ToolbarButton
                  onClick={() => setIsWebcamOn((w) => !w)}
                  title={isWebcamOn ? 'Hide Webcam' : 'Show Webcam'}
                  active={isWebcamOn}
                  activeColor="rgba(99,102,241,0.2)"
                >
                  {isWebcamOn ? (
                    <Video size={13} style={{ color: '#818cf8' }} />
                  ) : (
                    <VideoOff size={13} />
                  )}
                </ToolbarButton>

                {/* Annotate */}
                <ToolbarButton
                  onClick={() => {
                    // Capture page screenshot and open annotation
                    chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, (response) => {
                      if (response?.shareUrl) {
                        // In real implementation, we'd capture locally and annotate
                      }
                    });
                  }}
                  title="Annotate"
                >
                  <Edit3 size={13} />
                </ToolbarButton>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Keyframe animation injected into document */}
      <style>{`
        @keyframes jam-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.3); }
        }
      `}</style>
    </motion.div>
  );
}

// ─── Toolbar Button ───────────────────────────────────────────────────────────

interface ToolbarButtonProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  active?: boolean;
  color?: string;
  activeColor?: string;
  danger?: boolean;
}

function ToolbarButton({
  onClick,
  title,
  children,
  active = false,
  color,
  activeColor,
  danger = false,
}: ToolbarButtonProps) {
  const [isHovered, setIsHovered] = useState(false);

  const bgColor = danger
    ? isHovered
      ? 'rgba(239,68,68,0.3)'
      : 'rgba(239,68,68,0.15)'
    : active
      ? (activeColor ?? 'rgba(255,255,255,0.12)')
      : isHovered
        ? 'rgba(255,255,255,0.12)'
        : 'rgba(255,255,255,0.06)';

  const textColor = color ?? (danger ? '#ef4444' : active ? 'white' : 'rgba(148,163,184,0.9)');

  return (
    <motion.button
      whileTap={{ scale: 0.88 }}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '32px',
        height: '32px',
        borderRadius: '10px',
        border: danger ? '1px solid rgba(239,68,68,0.3)' : '1px solid transparent',
        background: bgColor,
        color: textColor,
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        flexShrink: 0,
      }}
    >
      {children}
    </motion.button>
  );
}
