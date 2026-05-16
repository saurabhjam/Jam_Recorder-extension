import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Square,
  Pause,
  Play,
  Mic,
  MicOff,
  Camera,
  CameraOff,
  X,
  Monitor,
  Chrome,
  Video,
} from 'lucide-react';
import { useRecording } from '@/hooks/useRecording';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/utils';

interface RecordingViewProps {
  onCancel: () => void;
}

const TYPE_ICONS = {
  screen: <Monitor size={18} />,
  tab: <Chrome size={18} />,
  webcam: <Video size={18} />,
  screenshot: <Camera size={18} />,
};

const TYPE_LABELS = {
  screen: 'Screen Recording',
  tab: 'Tab Recording',
  webcam: 'Webcam Recording',
  screenshot: 'Screenshot',
};

export function RecordingView({ onCancel }: RecordingViewProps) {
  const {
    status,
    recordingType,
    formattedTime,
    isRecording,
    isPaused,
    isMicMuted,
    isWebcamVisible,
    handleStop,
    handlePause,
    handleResume,
    toggleMic,
    toggleWebcam,
  } = useRecording();

  const [isStopping, setIsStopping] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Simulate mic level animation (real implementation would use AnalyserNode)
  useEffect(() => {
    if (!isRecording || isMicMuted) {
      setMicLevel(0);
      return;
    }

    const interval = setInterval(() => {
      setMicLevel(Math.random() * 80 + 10);
    }, 100);

    return () => clearInterval(interval);
  }, [isRecording, isMicMuted]);

  // Cleanup analyser on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (analyserRef.current) {
        analyserRef.current.disconnect();
      }
    };
  }, []);

  const handleStopClick = async () => {
    setIsStopping(true);
    try {
      await handleStop();
    } catch {
      setIsStopping(false);
    }
  };

  const handleCancelClick = () => {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    onCancel();
  };

  return (
    <div className="h-full flex flex-col items-center justify-between px-6 py-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2 text-dark-400">
          {recordingType && TYPE_ICONS[recordingType]}
          <span className="text-xs font-medium">
            {recordingType ? TYPE_LABELS[recordingType] : 'Recording'}
          </span>
        </div>
        <Badge variant={isPaused ? 'warning' : 'danger'} dot>
          {isPaused ? 'Paused' : 'Recording'}
        </Badge>
      </motion.div>

      {/* Center: Timer + Pulse */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="flex flex-col items-center gap-6"
      >
        {/* Recording Pulse Ring */}
        <div className="relative flex items-center justify-center">
          {/* Outer ring pulses */}
          {isRecording && !isPaused && (
            <>
              <motion.div
                className="absolute w-28 h-28 rounded-full border border-red-500/20"
                animate={{ scale: [1, 1.3, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <motion.div
                className="absolute w-24 h-24 rounded-full border border-red-500/30"
                animate={{ scale: [1, 1.2, 1], opacity: [0.8, 0.2, 0.8] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }}
              />
            </>
          )}

          {/* Center button */}
          <motion.div
            className={cn(
              'relative w-20 h-20 rounded-full flex items-center justify-center',
              'border-2 shadow-recording',
              isPaused ? 'bg-amber-500/15 border-amber-500/60' : 'bg-red-500/15 border-red-500/60',
            )}
            animate={
              isRecording && !isPaused
                ? {
                    boxShadow: [
                      '0 0 20px rgba(239,68,68,0.3)',
                      '0 0 40px rgba(239,68,68,0.6)',
                      '0 0 20px rgba(239,68,68,0.3)',
                    ],
                  }
                : {}
            }
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            <div className={cn('w-8 h-8 rounded-full', isPaused ? 'bg-amber-400' : 'bg-red-500')} />
          </motion.div>
        </div>

        {/* Timer */}
        <div className="text-center">
          <motion.div
            key={formattedTime}
            className="font-mono text-5xl font-bold text-white tabular-nums tracking-tight"
            animate={{ scale: [1, 1.02, 1] }}
            transition={{ duration: 0.3 }}
          >
            {formattedTime}
          </motion.div>
          <p className="text-xs text-dark-400 mt-2">
            {isPaused ? 'Recording paused' : 'Recording in progress...'}
          </p>
        </div>

        {/* Mic Level Indicator */}
        <AnimatePresence>
          {!isMicMuted && isRecording && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-end gap-0.5 h-6"
            >
              {Array.from({ length: 12 }, (_, i) => {
                const threshold = (i / 12) * 100;
                const active = micLevel > threshold;

                return (
                  <motion.div
                    key={i}
                    className={cn(
                      'w-1 rounded-full transition-all duration-75',
                      active ? 'bg-jam-400' : 'bg-dark-700',
                    )}
                    animate={{ height: active ? `${Math.random() * 16 + 4}px` : '4px' }}
                    transition={{ duration: 0.1 }}
                  />
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Controls */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="w-full flex flex-col gap-3"
      >
        {/* Primary Controls */}
        <div className="flex items-center gap-3">
          {/* Pause / Resume */}
          <Button
            variant={isPaused ? 'primary' : 'secondary'}
            size="lg"
            className="flex-1"
            onClick={isPaused ? handleResume : handlePause}
            leftIcon={isPaused ? <Play size={18} /> : <Pause size={18} />}
          >
            {isPaused ? 'Resume' : 'Pause'}
          </Button>

          {/* Stop */}
          <Button
            variant="danger"
            size="lg"
            className="flex-1"
            loading={isStopping}
            onClick={() => void handleStopClick()}
            leftIcon={!isStopping ? <Square size={18} /> : undefined}
          >
            {isStopping ? 'Stopping...' : 'Stop'}
          </Button>
        </div>

        {/* Secondary Controls */}
        <div className="flex items-center gap-2">
          {/* Mic Toggle */}
          <motion.button
            whileTap={{ scale: 0.92 }}
            onClick={toggleMic}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 h-9 rounded-xl text-xs font-medium transition-all duration-200 border',
              isMicMuted
                ? 'bg-red-500/15 text-red-400 border-red-500/30'
                : 'bg-dark-800 text-dark-300 border-white/8 hover:border-white/16',
            )}
          >
            {isMicMuted ? <MicOff size={14} /> : <Mic size={14} />}
            {isMicMuted ? 'Mic Off' : 'Mic On'}
          </motion.button>

          {/* Webcam Toggle */}
          <motion.button
            whileTap={{ scale: 0.92 }}
            onClick={toggleWebcam}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 h-9 rounded-xl text-xs font-medium transition-all duration-200 border',
              isWebcamVisible
                ? 'bg-jam-500/15 text-jam-400 border-jam-500/30'
                : 'bg-dark-800 text-dark-300 border-white/8 hover:border-white/16',
            )}
          >
            {isWebcamVisible ? <Camera size={14} /> : <CameraOff size={14} />}
            {isWebcamVisible ? 'Cam On' : 'Cam Off'}
          </motion.button>

          {/* Cancel */}
          <motion.button
            whileTap={{ scale: 0.92 }}
            onClick={handleCancelClick}
            className="h-9 px-3 rounded-xl text-xs font-medium bg-dark-800 text-dark-400 border border-white/8 hover:text-red-400 hover:border-red-500/30 transition-all duration-200 flex items-center gap-1.5"
          >
            <X size={14} />
            Cancel
          </motion.button>
        </div>
      </motion.div>
    </div>
  );
}
