import { motion } from 'framer-motion';
import { Check, Loader2, X } from 'lucide-react';
import { useRecordingStore } from '@/store/recording.store';
import { formatBytes } from '@/utils';
import { InstanceBadge } from '@/components/ui/InstanceBadge';

type StepStatus = 'done' | 'active' | 'pending';

interface UploadStep {
  label: string;
  status: StepStatus;
}

function getSteps(percent: number): UploadStep[] {
  const compressionDone = percent >= 20;
  const thumbnailDone = percent >= 40;
  const uploadingActive = percent < 95 && percent >= 40;
  const uploadingDone = percent >= 95;
  const syncingActive = percent >= 95 && percent < 100;
  const syncingDone = percent >= 100;

  return [
    {
      label: 'Compressing video',
      status: compressionDone ? 'done' : percent > 0 ? 'active' : 'pending',
    },
    {
      label: 'Generating thumbnail',
      status: thumbnailDone ? 'done' : compressionDone ? 'active' : 'pending',
    },
    {
      label: 'Uploading...',
      status: uploadingDone ? 'done' : uploadingActive ? 'active' : 'pending',
    },
    {
      label: 'Syncing data',
      status: syncingDone ? 'done' : syncingActive ? 'active' : 'pending',
    },
  ];
}

export function UploadView() {
  const { uploadProgress, currentRecordingId } = useRecordingStore();

  const handleCancelUpload = () => {
    if (currentRecordingId) {
      chrome.runtime.sendMessage({
        type: 'STOP_RECORDING',
        payload: { cancel: true, recordingId: currentRecordingId },
      });
    }
  };

  const percent = uploadProgress?.percentComplete ?? 0;
  const totalBytes = uploadProgress?.totalBytes ?? 0;
  const uploadedBytes = uploadProgress?.uploadedBytes ?? 0;

  // SVG circular ring
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percent / 100) * circumference;

  const steps = getSteps(percent);

  return (
    <div className="relative h-full flex flex-col items-center justify-center px-6 py-6 gap-6">
      <div className="absolute top-3 right-3">
        <InstanceBadge size={14} />
      </div>

      {/* ─── Circular Progress Ring ─── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 280, damping: 22 }}
        className="relative flex items-center justify-center"
      >
        {/* Outer glow */}
        <motion.div
          className="absolute rounded-full bg-jam-500/15"
          style={{ width: 148, height: 148 }}
          animate={{ scale: [1, 1.12, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        />

        <svg width="136" height="136" viewBox="0 0 136 136" className="rotate-[-90deg]">
          {/* Track */}
          <circle
            cx="68"
            cy="68"
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="10"
            strokeLinecap="round"
          />
          {/* Progress */}
          <motion.circle
            cx="68"
            cy="68"
            r={radius}
            fill="none"
            stroke="url(#progressGradient)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            animate={{ strokeDashoffset }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
          <defs>
            <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#7C3AED" />
              <stop offset="100%" stopColor="#a78bfa" />
            </linearGradient>
          </defs>
        </svg>

        {/* Center label */}
        <div className="absolute flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-white tabular-nums">{Math.round(percent)}%</span>
          {totalBytes > 0 && (
            <span className="text-xxs text-dark-400 mt-0.5">{formatBytes(uploadedBytes)}</span>
          )}
        </div>
      </motion.div>

      {/* ─── Title & Subtitle ─── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18 }}
        className="text-center"
      >
        <h2 className="text-base font-bold text-white">Uploading your recording...</h2>
        {totalBytes > 0 && (
          <p className="text-xs text-dark-400 mt-1">
            {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)}
          </p>
        )}
      </motion.div>

      {/* ─── Steps Checklist ─── */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="w-full max-w-xs flex flex-col gap-2.5"
      >
        {steps.map((step, i) => (
          <UploadStep key={i} step={step} index={i} />
        ))}
      </motion.div>

      {/* ─── Background note ─── */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="text-center text-xxs text-dark-500 max-w-[240px] leading-relaxed"
      >
        You can close this window, we'll continue in the background.
      </motion.p>

      {/* ─── Cancel ─── */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>
        <button
          onClick={handleCancelUpload}
          className="flex items-center gap-1.5 text-xxs text-dark-500 hover:text-red-400 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-500/8"
        >
          <X size={12} />
          Cancel Upload
        </button>
      </motion.div>
    </div>
  );
}

// ─── Upload Step ──────────────────────────────────────────────────────────────

interface UploadStepProps {
  step: UploadStep;
  index: number;
}

function UploadStep({ step, index }: UploadStepProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.3 + index * 0.06 }}
      className="flex items-center gap-3"
    >
      {/* Status icon */}
      <div className="shrink-0 w-5 h-5 flex items-center justify-center">
        {step.status === 'done' ? (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center"
          >
            <Check size={10} className="text-emerald-400" />
          </motion.div>
        ) : step.status === 'active' ? (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            className="w-5 h-5 rounded-full border-2 border-jam-500/30 border-t-jam-400 flex items-center justify-center"
          >
            <Loader2 size={10} className="text-jam-400 opacity-0" />
          </motion.div>
        ) : (
          <div className="w-5 h-5 rounded-full border border-white/10 bg-dark-800/60" />
        )}
      </div>

      {/* Label */}
      <span
        className={
          step.status === 'done'
            ? 'text-xs text-emerald-400 font-medium'
            : step.status === 'active'
              ? 'text-xs text-white font-medium'
              : 'text-xs text-dark-500'
        }
      >
        {step.label}
      </span>

      {/* Active spinner dot */}
      {step.status === 'active' && (
        <motion.div
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{ duration: 1.2, repeat: Infinity }}
          className="w-1.5 h-1.5 rounded-full bg-jam-400 ml-auto"
        />
      )}
    </motion.div>
  );
}
