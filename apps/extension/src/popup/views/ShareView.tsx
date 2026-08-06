import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Copy,
  Check,
  ExternalLink,
  Plus,
  Monitor,
  Chrome,
  Camera,
  Image,
  Edit2,
  Save,
  Loader2,
} from 'lucide-react';
import { useRecordingStore } from '@/store/recording.store';
import { useClipboard } from '@/hooks/useClipboard';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { InstanceBadge } from '@/components/ui/InstanceBadge';
import { recordingsApi } from '@/services/api';
import { formatDuration } from '@/utils';
import { useAuthedThumbnail } from '../useAuthedThumbnail';
import type { Recording } from '@/types';

interface ShareViewProps {
  onRecordAnother: () => void;
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  SCREEN: <Monitor size={20} />,
  TAB: <Chrome size={20} />,
  WEBCAM: <Camera size={20} />,
  SCREENSHOT: <Image size={20} />,
};

export function ShareView({ onRecordAnother }: ShareViewProps) {
  const { shareUrl, currentRecordingId, reset } = useRecordingStore();
  const { copied, copy } = useClipboard();
  const { showToast } = useToast();

  const [recording, setRecording] = useState<Recording | null>(null);
  const thumbnailSrc = useAuthedThumbnail(recording?.thumbnailUrl);
  const [title, setTitle] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isFetchingMeta, setIsFetchingMeta] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Fetch recording metadata once we have an ID
  useEffect(() => {
    if (!currentRecordingId) return;
    setIsFetchingMeta(true);
    recordingsApi
      .get(currentRecordingId)
      .then((r) => {
        setRecording(r);
        setTitle(r.title);
      })
      .catch(() => {})
      .finally(() => setIsFetchingMeta(false));
  }, [currentRecordingId]);

  // Focus title input when entering edit mode
  useEffect(() => {
    if (isEditingTitle) titleInputRef.current?.select();
  }, [isEditingTitle]);

  const handleCopy = async () => {
    if (!shareUrl) return;
    const ok = await copy(shareUrl);
    showToast(ok ? 'Link copied!' : 'Failed to copy link', ok ? 'success' : 'error');
  };

  const handleOpenInBrowser = () => {
    if (shareUrl) chrome.tabs.create({ url: shareUrl });
  };

  const handleSaveTitle = async () => {
    if (!currentRecordingId || !title.trim()) return;
    setIsSavingTitle(true);
    try {
      await recordingsApi.updateTitle(currentRecordingId, title.trim());
      setRecording((r) => (r ? { ...r, title: title.trim() } : r));
      setIsEditingTitle(false);
      showToast('Title saved!', 'success');
    } catch {
      showToast('Failed to save title', 'error');
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleRecordAnother = () => {
    reset();
    onRecordAnother();
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-2.5 px-4 pt-4 pb-3 border-b border-white/6 shrink-0"
      >
        {/* Success dot */}
        <div className="w-8 h-8 rounded-xl bg-green-500/15 border border-green-500/30 flex items-center justify-center">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 350, damping: 20, delay: 0.1 }}
          >
            <Check size={16} className="text-green-400" />
          </motion.div>
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-none">Recording ready</p>
          <p className="text-xxs text-dark-400 mt-0.5">Upload complete — share it now</p>
        </div>
        <InstanceBadge size={14} className="ml-auto" />
      </motion.div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 flex flex-col gap-3">
        {/* ── Thumbnail / Preview card ── */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 }}
          className="relative w-full rounded-2xl overflow-hidden bg-dark-800 border border-white/8 aspect-video flex items-center justify-center group"
        >
          {isFetchingMeta ? (
            <Loader2 size={24} className="text-dark-500 animate-spin" />
          ) : thumbnailSrc ? (
            <>
              <img
                src={thumbnailSrc}
                alt={recording.title}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <button
                  onClick={handleOpenInBrowser}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 text-white text-xs font-semibold border border-white/20 hover:bg-white/20 transition-colors"
                >
                  <ExternalLink size={14} />
                  Watch
                </button>
              </div>
              {/* Duration badge */}
              {recording.duration > 0 && (
                <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-lg bg-black/70 text-white text-xxs font-mono">
                  {formatDuration(recording.duration)}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 text-dark-500">
              <span>{TYPE_ICON[recording?.type ?? 'SCREEN']}</span>
              <p className="text-xxs font-medium">
                {recording?.type === 'SCREENSHOT' ? 'Screenshot' : 'Video recording'}
              </p>
              {recording?.duration ? (
                <p className="text-xxs font-mono text-dark-600">
                  {formatDuration(recording.duration)}
                </p>
              ) : null}
            </div>
          )}
        </motion.div>

        {/* ── Editable Title ── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="flex items-center gap-2 p-3 rounded-xl bg-dark-800/60 border border-white/8"
        >
          {isEditingTitle ? (
            <>
              <input
                ref={titleInputRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveTitle();
                  if (e.key === 'Escape') setIsEditingTitle(false);
                }}
                className="flex-1 bg-transparent text-xs font-medium text-white outline-none placeholder:text-dark-500"
                placeholder="Give this recording a title…"
                maxLength={120}
              />
              <button
                onClick={() => void handleSaveTitle()}
                disabled={isSavingTitle}
                className="shrink-0 p-1.5 rounded-lg bg-jam-500/20 text-jam-300 hover:bg-jam-500/30 transition-colors disabled:opacity-50"
                title="Save"
              >
                {isSavingTitle ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Save size={13} />
                )}
              </button>
            </>
          ) : (
            <>
              <p className="flex-1 text-xs font-medium text-white truncate">
                {title || recording?.title || 'Untitled Recording'}
              </p>
              <button
                onClick={() => setIsEditingTitle(true)}
                className="shrink-0 p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-white/6 transition-colors"
                title="Edit title"
              >
                <Edit2 size={13} />
              </button>
            </>
          )}
        </motion.div>

        {/* ── Share URL ── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="flex items-center gap-2 bg-dark-800/80 border border-white/8 rounded-xl p-1 pr-2"
        >
          <p className="flex-1 px-3 py-2 text-xs text-dark-400 font-mono truncate">
            {shareUrl?.replace(/^https?:\/\//, '') ?? 'Generating link…'}
          </p>
          <motion.button
            whileTap={{ scale: 0.92 }}
            onClick={() => void handleCopy()}
            disabled={!shareUrl}
            className={`shrink-0 h-7 px-3 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              copied
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-jam-500/20 text-jam-300 border border-jam-500/30 hover:bg-jam-500/30'
            }`}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied!' : 'Copy'}
          </motion.button>
        </motion.div>

        {/* ── Action Buttons ── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="flex gap-2"
        >
          <Button
            variant="primary"
            size="md"
            fullWidth
            onClick={handleOpenInBrowser}
            rightIcon={<ExternalLink size={14} />}
            disabled={!shareUrl}
          >
            Open in Browser
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={handleRecordAnother}
            leftIcon={<Plus size={14} />}
            className="shrink-0"
          >
            New
          </Button>
        </motion.div>

        {/* ── Status badge ── */}
        {recording && recording.status !== 'READY' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20"
          >
            <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />
            <p className="text-xxs text-amber-300">
              Processing video in background — link is already shareable
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
