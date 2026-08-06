import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Search,
  Monitor,
  Camera,
  Image,
  Chrome,
  ExternalLink,
  Play,
  Trash2,
  Clock,
  Eye,
  Download,
  Copy,
  Check,
  Save,
  FileClock,
} from 'lucide-react';
import { useRecordingStore } from '@/store/recording.store';
import { recordingsApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { InstanceBadge } from '@/components/ui/InstanceBadge';
import { useClipboard } from '@/hooks/useClipboard';
import { useToast } from '@/components/ui/Toast';
import { formatDuration, formatRelativeDate, formatBytes, debounce } from '@/utils';
import { useAuthedThumbnail } from '../useAuthedThumbnail';
import { useDrafts } from '../useDrafts';
import type { Recording, RecordingType, DraftRecording } from '@/types';

interface LibraryViewProps {
  onBack: () => void;
}

type FilterTab = 'all' | RecordingType;
type LibraryTab = 'library' | 'drafts';

const FILTER_TABS: Array<{ id: FilterTab; label: string; icon: React.ReactNode }> = [
  { id: 'all', label: 'All', icon: null },
  { id: 'screen', label: 'Screen', icon: <Monitor size={12} /> },
  { id: 'tab', label: 'Tab', icon: <Chrome size={12} /> },
  { id: 'webcam', label: 'Webcam', icon: <Camera size={12} /> },
  { id: 'screenshot', label: 'Photos', icon: <Image size={12} /> },
];

const TYPE_ICON: Record<RecordingType, React.ReactNode> = {
  screen: <Monitor size={14} />,
  tab: <Chrome size={14} />,
  webcam: <Camera size={14} />,
  screenshot: <Image size={14} />,
};

const TYPE_COLOR: Record<RecordingType, string> = {
  screen: 'text-jam-400',
  tab: 'text-blue-400',
  webcam: 'text-green-400',
  screenshot: 'text-amber-400',
};

export function LibraryView({ onBack }: LibraryViewProps) {
  const { recordings, fetchRecordings } = useRecordingStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<LibraryTab>('library');
  const drafts = useDrafts();

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await fetchRecordings();
      setIsLoading(false);
    };
    void load();
  }, [fetchRecordings]);

  const debouncedSearch = useMemo(
    () =>
      debounce((q: string) => {
        // In a real impl, this would call the search API
        console.log('Searching:', q);
      }, 400),
    [],
  );

  const filteredRecordings = useMemo(() => {
    let result = recordings;

    // Type filter
    if (activeFilter !== 'all') {
      result = result.filter((r) => r.type === activeFilter);
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((r) => r.title.toLowerCase().includes(q));
    }

    return result;
  }, [recordings, activeFilter, searchQuery]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await recordingsApi.delete(id);
      await fetchRecordings();
    } catch (err) {
      console.error('Delete error:', err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleOpen = (recording: Recording) => {
    if (recording.shareUrl) {
      chrome.tabs.create({ url: recording.shareUrl });
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <button onClick={onBack} className="icon-btn" title="Back">
            <ArrowLeft size={16} />
          </button>
          <h2 className="text-sm font-bold text-white flex-1">
            {activeTab === 'library' ? 'My Recordings' : 'Drafts'}
          </h2>
          <Badge variant="ghost" size="sm">
            {activeTab === 'library' ? filteredRecordings.length : drafts.drafts.length}
          </Badge>
          <InstanceBadge size={14} />
        </div>

        {/* Library / Drafts toggle */}
        <div className="flex gap-1.5 mb-3">
          {[
            { id: 'library' as const, label: 'Library' },
            { id: 'drafts' as const, label: 'Drafts' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-semibold transition-all duration-200 border ${
                activeTab === tab.id
                  ? 'bg-jam-500/20 text-jam-300 border-jam-500/30'
                  : 'bg-dark-800/60 text-dark-400 border-white/6 hover:border-white/12'
              }`}
            >
              {tab.id === 'drafts' && <FileClock size={12} />}
              {tab.label}
              {tab.id === 'drafts' && drafts.drafts.length > 0 && (
                <span className="text-xxs opacity-70">({drafts.drafts.length})</span>
              )}
            </button>
          ))}
        </div>

        {activeTab === 'library' && (
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-400 pointer-events-none"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                debouncedSearch(e.target.value);
              }}
              placeholder="Search recordings..."
              className="w-full h-9 pl-9 pr-3 rounded-xl text-xs bg-dark-800/80 border border-white/8 text-white placeholder:text-dark-500 focus:outline-none focus:border-jam-500/40 transition-colors"
            />
          </div>
        )}
      </div>

      {/* Filter Tabs */}
      {activeTab === 'library' && (
        <div className="px-4 pb-3 shrink-0">
          <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveFilter(tab.id)}
                className={`shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
                  activeFilter === tab.id
                    ? 'bg-jam-500/20 text-jam-300 border-jam-500/30'
                    : 'bg-dark-800/60 text-dark-400 border-white/6 hover:border-white/12'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
        {activeTab === 'drafts' ? (
          drafts.isLoading ? (
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
          )
        ) : isLoading ? (
          <LoadingSkeleton />
        ) : filteredRecordings.length === 0 ? (
          <EmptyState
            hasSearch={searchQuery.length > 0}
            hasFilter={activeFilter !== 'all'}
            onClearFilter={() => {
              setActiveFilter('all');
              setSearchQuery('');
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence mode="popLayout">
              {filteredRecordings.map((recording, i) => (
                <RecordingCard
                  key={recording.id}
                  recording={recording}
                  index={i}
                  isDeleting={deletingId === recording.id}
                  onOpen={handleOpen}
                  onDelete={() => void handleDelete(recording.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Recording Card ───────────────────────────────────────────────────────────

interface RecordingCardProps {
  recording: Recording;
  index: number;
  isDeleting: boolean;
  onOpen: (r: Recording) => void;
  onDelete: () => void;
}

function RecordingCard({ recording, index, isDeleting, onOpen, onDelete }: RecordingCardProps) {
  const [showActions, setShowActions] = useState(false);
  // thumbnailUrl is an authenticated API file URL — load it with a Bearer token
  // via blob, since a plain <img src> can't send the header and would 401.
  const thumbnailSrc = useAuthedThumbnail(recording.thumbnailUrl);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ delay: index * 0.04 }}
      className="flex gap-3 p-3 rounded-2xl bg-dark-800/60 border border-white/6 hover:border-white/10 transition-all duration-200 group"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Thumbnail */}
      <div className="w-16 h-11 rounded-xl overflow-hidden shrink-0 bg-dark-700 border border-white/5 flex items-center justify-center relative">
        {thumbnailSrc ? (
          <>
            <img src={thumbnailSrc} alt={recording.title} className="w-full h-full object-cover" />
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
              <Play size={16} className="text-white fill-white" />
            </div>
          </>
        ) : (
          <span className={TYPE_COLOR[recording.type]}>{TYPE_ICON[recording.type]}</span>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <button
          onClick={() => onOpen(recording)}
          className="text-xs font-semibold text-white hover:text-jam-300 transition-colors text-left truncate w-full block"
        >
          {recording.title}
        </button>

        <div className="flex items-center flex-wrap gap-1.5 mt-1">
          {recording.type !== 'screenshot' && (
            <span className="flex items-center gap-1 text-xxs text-dark-500">
              <Clock size={10} />
              {formatDuration(recording.duration)}
            </span>
          )}
          <span className="flex items-center gap-1 text-xxs text-dark-500">
            <Eye size={10} />
            {recording.views}
          </span>
          <span className="text-xxs text-dark-500">{formatRelativeDate(recording.createdAt)}</span>
          {recording.fileSize > 0 && (
            <span className="text-xxs text-dark-600">{formatBytes(recording.fileSize)}</span>
          )}
        </div>

        <div className="flex items-center gap-1 mt-1.5">
          <Badge
            variant={
              recording.status === 'READY'
                ? 'success'
                : recording.status === 'FAILED'
                  ? 'danger'
                  : 'warning'
            }
            size="sm"
            dot
          >
            {recording.status === 'READY'
              ? 'Ready'
              : recording.status === 'FAILED'
                ? 'Failed'
                : 'Processing'}
          </Badge>
        </div>
      </div>

      {/* Actions */}
      <AnimatePresence>
        {showActions && (
          <motion.div
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            className="flex flex-col gap-1 shrink-0"
          >
            <button
              onClick={() => onOpen(recording)}
              className="icon-btn w-7 h-7 rounded-lg"
              title="Open"
            >
              <ExternalLink size={12} />
            </button>
            <Button
              variant="ghost"
              size="xs"
              loading={isDeleting}
              onClick={onDelete}
              className="w-7 h-7 p-0 rounded-lg text-dark-400 hover:text-red-400 hover:bg-red-500/10"
              title="Delete"
            >
              {!isDeleting && <Trash2 size={12} />}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
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
        <FileClock size={22} className="text-dark-500" />
      </div>
      <div>
        <p className="text-sm font-semibold text-dark-300">No drafts</p>
        <p className="text-xs text-dark-500 mt-1">
          Your last 5 recordings show up here until saved
        </p>
      </div>
    </motion.div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

interface EmptyStateProps {
  hasSearch: boolean;
  hasFilter: boolean;
  onClearFilter: () => void;
}

function EmptyState({ hasSearch, hasFilter, onClearFilter }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-3 py-12 text-center"
    >
      <div className="w-14 h-14 rounded-2xl bg-dark-800 flex items-center justify-center">
        {hasSearch || hasFilter ? (
          <Search size={22} className="text-dark-500" />
        ) : (
          <Monitor size={22} className="text-dark-500" />
        )}
      </div>

      <div>
        <p className="text-sm font-semibold text-dark-300">
          {hasSearch ? 'No results found' : hasFilter ? 'No recordings here' : 'No recordings yet'}
        </p>
        <p className="text-xs text-dark-500 mt-1">
          {hasSearch
            ? 'Try a different search term'
            : hasFilter
              ? 'Try a different filter'
              : 'Start recording to see them here'}
        </p>
      </div>

      {(hasSearch || hasFilter) && (
        <Button variant="outline" size="sm" onClick={onClearFilter}>
          Clear Filters
        </Button>
      )}
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
