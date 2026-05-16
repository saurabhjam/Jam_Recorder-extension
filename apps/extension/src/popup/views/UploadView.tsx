import { motion } from 'framer-motion';
import { Upload, X, Wifi } from 'lucide-react';
import { useRecordingStore } from '@/store/recording.store';
import { ProgressBar, SegmentedProgress } from '@/components/ProgressBar';
import { Button } from '@/components/ui/Button';
import { formatBytes, formatUploadSpeed, formatETA } from '@/utils';

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
  const speed = uploadProgress?.speed ?? 0;
  const totalBytes = uploadProgress?.totalBytes ?? 0;
  const uploadedBytes = uploadProgress?.uploadedBytes ?? 0;
  const totalChunks = uploadProgress?.totalChunks ?? 0;
  const uploadedChunks = uploadProgress?.uploadedChunks ?? 0;
  const eta = uploadProgress?.eta ?? 0;

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-8 gap-8">
      {/* Upload Icon Animation */}
      <motion.div
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="relative"
      >
        {/* Outer glow ring */}
        <motion.div
          className="absolute inset-0 rounded-full bg-jam-500/20"
          animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
        />

        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-jam-500/20 to-violet-500/20 border border-jam-500/30 flex items-center justify-center">
          <motion.div
            animate={{ y: [-3, 3, -3] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Upload size={28} className="text-jam-400" />
          </motion.div>
        </div>
      </motion.div>

      {/* Title & Subtitle */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="text-center"
      >
        <h2 className="text-lg font-bold text-white">Uploading Recording</h2>
        <p className="text-sm text-dark-400 mt-1">Your recording is being processed...</p>
      </motion.div>

      {/* Progress Section */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="w-full space-y-4"
      >
        {/* Main Progress Bar */}
        <ProgressBar value={percent} label="Upload Progress" size="lg" />

        {/* Chunk Progress */}
        {totalChunks > 1 && <SegmentedProgress total={totalChunks} completed={uploadedChunks} />}

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-2">
          <StatCard
            label="Speed"
            value={speed > 0 ? formatUploadSpeed(speed) : '--'}
            icon={<Wifi size={12} />}
          />
          <StatCard label="Uploaded" value={totalBytes > 0 ? formatBytes(uploadedBytes) : '--'} />
          <StatCard
            label="ETA"
            value={eta > 0 ? formatETA(totalBytes - uploadedBytes, speed) : '--'}
          />
        </div>

        {/* File size detail */}
        {totalBytes > 0 && (
          <p className="text-center text-xxs text-dark-500">
            {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)} uploaded
            {totalChunks > 1 && (
              <>
                {' '}
                &nbsp;&bull;&nbsp; Chunk {uploadedChunks} / {totalChunks}
              </>
            )}
          </p>
        )}
      </motion.div>

      {/* Cancel Button */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCancelUpload}
          leftIcon={<X size={14} />}
          className="text-dark-400 hover:text-red-400"
        >
          Cancel Upload
        </Button>
      </motion.div>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  icon?: React.ReactNode;
}

function StatCard({ label, value, icon }: StatCardProps) {
  return (
    <div className="bg-dark-800/60 border border-white/6 rounded-xl p-2.5 text-center">
      <div className="flex items-center justify-center gap-1 text-dark-400 mb-1">
        {icon}
        <span className="text-xxs font-medium">{label}</span>
      </div>
      <p className="text-sm font-bold text-white font-mono">{value}</p>
    </div>
  );
}
