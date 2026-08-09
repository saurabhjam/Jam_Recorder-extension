import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  History,
  Play,
  Clock,
  Trash2,
  Download,
  Copy,
  Check,
  Save,
  Globe,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { InstanceBadge } from '@/components/ui/InstanceBadge';
import { useClipboard } from '@/hooks/useClipboard';
import { useToast } from '@/components/ui/Toast';
import { formatDuration, formatRelativeDate, formatBytes } from '@/utils';
import { useDrafts } from '../useDrafts';
import type { DraftRecording } from '@/types';

interface LibraryViewProps {
  onBack: () => void;
}

export function LibraryView({ onBack }: LibraryViewProps) {
  const drafts = useDrafts();

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <button onClick={onBack} className="icon-btn" title="Back">
            <ArrowLeft size={16} />
          </button>
          <h2 className="text-sm font-bold text-white flex-1">My Recordings</h2>
          <Badge variant="ghost" size="sm">
            {drafts.drafts.length}
          </Badge>
          <InstanceBadge size={14} />
        </div>

        {/* Recent tab */}
        <div className="flex gap-1.5">
          <div className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-semibold border bg-jam-500/10 text-jam-300 border-jam-500/20">
            <History size={12} />
            Recent
            {drafts.drafts.length > 0 && (
              <span className="text-xxs opacity-70">({drafts.drafts.length})</span>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
        {drafts.isLoading ? (
          <LoadingSkeleton />
        ) : drafts.drafts.length === 0 ? (
          <DraftsEmptyState />
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence mode="popLayout">
              {drafts.drafts.map((draft, i) => (
                <DraftCard
                  key={draft.recordingId}
                  draft={draft}
                  index={i}
                  isBusy={drafts.busyId === draft.recordingId}
                  onSave={() => drafts.openInEditor(draft.recordingId)}
                  onDownload={() => drafts.download(draft)}
                  onDiscard={() => drafts.discard(draft.recordingId)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Draft Card ───────────────────────────────────────────────────────────────

interface DraftCardProps {
  draft: DraftRecording;
  index: number;
  isBusy: boolean;
  onSave: () => void;
  onDownload: () => void;
  onDiscard: () => void;
}

function DraftCard({ draft, index, isBusy, onSave, onDownload, onDiscard }: DraftCardProps) {
  const { copied, copy } = useClipboard();
  const { showToast } = useToast();

  const handleCopyLink = async () => {
    if (!draft.shareUrl) return;
    const ok = await copy(draft.shareUrl);
    showToast(ok ? 'Link copied!' : 'Failed to copy link', ok ? 'success' : 'error');
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ delay: index * 0.04 }}
      className="flex gap-3 p-3 rounded-2xl bg-dark-800/60 border border-white/6 hover:border-white/10 transition-all duration-200"
    >
      {/* Thumbnail */}
      <div className="w-16 h-11 rounded-xl overflow-hidden shrink-0 bg-dark-700 border border-white/5 flex items-center justify-center">
        {draft.thumbnailDataUrl ? (
          <img
            src={draft.thumbnailDataUrl}
            alt={draft.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <Play size={14} className="text-dark-500" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white truncate">{draft.title}</p>

        <div className="flex items-center flex-wrap gap-1.5 mt-1">
          <span className="flex items-center gap-1 text-xxs text-dark-500">
            <Clock size={10} />
            {formatDuration(draft.duration)}
          </span>
          <span className="text-xxs text-dark-500">
            {formatRelativeDate(new Date(draft.createdAt))}
          </span>
          {draft.blobSize > 0 && (
            <span className="text-xxs text-dark-600">{formatBytes(draft.blobSize)}</span>
          )}
        </div>

        <div className="flex items-center gap-1 mt-1.5">
          <Badge variant={draft.status === 'saved' ? 'success' : 'warning'} size="sm" dot>
            {draft.status === 'saved' ? 'Saved' : 'Draft'}
          </Badge>
          {draft.status === 'saved' && (
            <Badge variant={draft.isPublic ? 'warning' : 'ghost'} size="sm">
              {draft.isPublic ? <Globe size={10} /> : <Lock size={10} />}
              {draft.isPublic ? 'Public' : 'Private'}
            </Badge>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1 shrink-0">
        {draft.status === 'draft' ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={onSave}
            className="w-7 h-7 p-0 rounded-lg text-dark-400 hover:text-jam-300 hover:bg-jam-500/10"
            title="Save"
          >
            <Save size={12} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void handleCopyLink()}
            className="w-7 h-7 p-0 rounded-lg text-dark-400 hover:text-jam-300 hover:bg-jam-500/10"
            title="Copy link"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          loading={isBusy}
          onClick={onDownload}
          className="w-7 h-7 p-0 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-white/6"
          title="Download"
        >
          {!isBusy && <Download size={12} />}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={onDiscard}
          className="w-7 h-7 p-0 rounded-lg text-dark-400 hover:text-red-400 hover:bg-red-500/10"
          title="Discard"
        >
          <Trash2 size={12} />
        </Button>
      </div>
    </motion.div>
  );
}

function DraftsEmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-3 py-12 text-center"
    >
      <div className="w-14 h-14 rounded-2xl bg-dark-800 flex items-center justify-center">
        <History size={22} className="text-dark-500" />
      </div>
      <div>
        <p className="text-sm font-semibold text-dark-300">No recordings yet</p>
        <p className="text-xs text-dark-500 mt-1">
          Your last 5 recordings show up here until saved
        </p>
      </div>
    </motion.div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className="flex gap-3 p-3 rounded-2xl bg-dark-800/60 border border-white/6 animate-pulse"
          style={{ animationDelay: `${i * 100}ms` }}
        >
          <div className="w-16 h-11 rounded-xl bg-dark-700 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-dark-700 rounded w-3/4" />
            <div className="h-2.5 bg-dark-700 rounded w-1/2" />
            <div className="h-4 bg-dark-700 rounded w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}
