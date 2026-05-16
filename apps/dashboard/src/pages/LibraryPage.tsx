import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Grid3X3,
  List,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Plus,
  ChevronDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { RecordingCard } from '@components/RecordingCard';
import { SkeletonRecordingCard } from '@components/Skeleton';
import { Button } from '@components/ui/Button';
import { Modal, ModalFooter } from '@components/ui/Modal';
import { Dropdown, DropdownTrigger, DropdownContent, DropdownItem } from '@components/ui/Dropdown';
import { useRecordings, useDeleteRecording, useUpdateRecording } from '@hooks/useRecordings';
import { api } from '@services/api';
import { cn, debounce } from '@utils/index';
import type { RecordingTypeDB } from '@snaptrace/types';

type SortKey = 'createdAt' | 'viewCount' | 'duration';
type SortLabel = 'Newest' | 'Oldest' | 'Most viewed' | 'Longest';

const SORT_OPTIONS: Array<{ label: SortLabel; sortBy: SortKey; sortOrder: 'asc' | 'desc' }> = [
  { label: 'Newest', sortBy: 'createdAt', sortOrder: 'desc' },
  { label: 'Oldest', sortBy: 'createdAt', sortOrder: 'asc' },
  { label: 'Most viewed', sortBy: 'viewCount', sortOrder: 'desc' },
  { label: 'Longest', sortBy: 'duration', sortOrder: 'desc' },
];

const TYPE_FILTERS: Array<{ label: string; value: RecordingTypeDB | 'ALL' }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Screen', value: 'SCREEN' },
  { label: 'Tab', value: 'TAB' },
  { label: 'Webcam', value: 'WEBCAM' },
  { label: 'Screenshot', value: 'SCREENSHOT' },
];

const PAGE_LIMIT = 16;

export default function LibraryPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<RecordingTypeDB | 'ALL'>('ALL');
  const [sort, setSort] = useState(SORT_OPTIONS[0]);
  const [page, setPage] = useState(1);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { mutate: deleteRecording, isPending: deleting } = useDeleteRecording();
  const { mutate: updateRecording } = useUpdateRecording();

  const handleSearch = useCallback(
    debounce((...args: unknown[]) => {
      setDebouncedQ(args[0] as string);
      setPage(1);
    }, 350),
    [],
  );

  const query = {
    search: debouncedQ || undefined,
    type: typeFilter !== 'ALL' ? typeFilter : undefined,
    sortBy: sort.sortBy,
    sortOrder: sort.sortOrder,
    page,
    limit: PAGE_LIMIT,
  };

  const { data, isLoading, isFetching } = useRecordings(query);
  const recordings = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_LIMIT);

  const handleDelete = () => {
    if (deleteId) {
      deleteRecording(deleteId, { onSuccess: () => setDeleteId(null) });
    }
  };

  const handleEdit = (id: string, title: string) => {
    updateRecording({ id, body: { title } });
  };

  const handleDownload = async (id: string) => {
    const blob = await api.downloadRecording(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snaptrace-recording-${id}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentTypeLabel = TYPE_FILTERS.find((f) => f.value === typeFilter)?.label ?? 'All';

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-50 tracking-tight">Recordings</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {total > 0
              ? `${total} recording${total !== 1 ? 's' : ''}`
              : 'All your recordings in one place'}
          </p>
        </div>

        {/* New Recording button - top right */}
        <div className="sm:ml-auto">
          <button
            onClick={() => window.open('https://snaptrace.app', '_blank')}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0"
            style={{
              background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
              boxShadow: '0 4px 16px rgba(124,58,237,0.4)',
            }}
          >
            <Plus className="h-4 w-4" />
            New Recording
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div
        className="flex flex-wrap items-center gap-3 p-3 rounded-2xl"
        style={{
          background: 'rgba(255,255,255,0.025)',
          border: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        {/* Search */}
        <div className="relative flex-1 min-w-0" style={{ maxWidth: 280 }}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
          <input
            type="search"
            placeholder="Search recordings..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              handleSearch(e.target.value);
            }}
            className="pl-9 pr-4 h-9 w-full text-sm rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.09)',
            }}
          />
        </div>

        {/* Type filter dropdown */}
        <Dropdown>
          <DropdownTrigger asChild>
            <button
              className="inline-flex items-center gap-2 px-3 h-9 rounded-xl text-sm text-slate-300 transition-colors hover:text-slate-100 flex-shrink-0"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.09)',
              }}
            >
              {currentTypeLabel}
              <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
            </button>
          </DropdownTrigger>
          <DropdownContent align="start">
            {TYPE_FILTERS.map((f) => (
              <DropdownItem
                key={f.value}
                onSelect={() => {
                  setTypeFilter(f.value);
                  setPage(1);
                }}
                className={typeFilter === f.value ? 'text-violet-400' : ''}
              >
                {f.label}
              </DropdownItem>
            ))}
          </DropdownContent>
        </Dropdown>

        <div className="flex-1" />

        {/* Sort dropdown */}
        <Dropdown>
          <DropdownTrigger asChild>
            <button
              className="inline-flex items-center gap-2 px-3 h-9 rounded-xl text-sm text-slate-300 transition-colors hover:text-slate-100 flex-shrink-0"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.09)',
              }}
            >
              <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
              {sort.label}
              <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
            </button>
          </DropdownTrigger>
          <DropdownContent align="end">
            {SORT_OPTIONS.map((s) => (
              <DropdownItem
                key={s.label}
                onSelect={() => {
                  setSort(s);
                  setPage(1);
                }}
                className={sort.label === s.label ? 'text-violet-400' : ''}
              >
                {s.label}
              </DropdownItem>
            ))}
          </DropdownContent>
        </Dropdown>

        {/* View toggle */}
        <div
          className="flex items-center rounded-lg p-1 gap-0.5 flex-shrink-0"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.09)',
          }}
        >
          <button
            onClick={() => setView('grid')}
            className={cn(
              'p-1.5 rounded-md transition-all duration-150',
              view === 'grid' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300',
            )}
            style={view === 'grid' ? { background: 'rgba(255,255,255,0.1)' } : {}}
          >
            <Grid3X3 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setView('list')}
            className={cn(
              'p-1.5 rounded-md transition-all duration-150',
              view === 'list' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300',
            )}
            style={view === 'list' ? { background: 'rgba(255,255,255,0.1)' } : {}}
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {view === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array.from({ length: 12 }).map((_, i) => (
                  <SkeletonRecordingCard key={i} />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-4 px-4 py-3 rounded-xl animate-pulse"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div
                      className="h-14 w-24 rounded-lg flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.04)' }}
                    />
                    <div className="flex-1 space-y-2">
                      <div
                        className="h-4 w-1/2 rounded"
                        style={{ background: 'rgba(255,255,255,0.04)' }}
                      />
                      <div
                        className="h-3 w-1/4 rounded"
                        style={{ background: 'rgba(255,255,255,0.04)' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        ) : recordings.length > 0 ? (
          <motion.div
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {view === 'grid' ? (
              <motion.div
                initial="hidden"
                animate="show"
                variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
                className={cn(
                  'grid gap-4',
                  'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
                  isFetching && 'opacity-60 pointer-events-none',
                )}
              >
                {recordings.map((rec) => (
                  <motion.div
                    key={rec.id}
                    variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
                  >
                    <RecordingCard
                      recording={rec}
                      view="grid"
                      onDelete={setDeleteId}
                      onEdit={handleEdit}
                      onDownload={handleDownload}
                      onClick={() => navigate('/library')}
                    />
                  </motion.div>
                ))}
              </motion.div>
            ) : (
              <div className={cn('space-y-2', isFetching && 'opacity-60 pointer-events-none')}>
                {recordings.map((rec) => (
                  <RecordingCard
                    key={rec.id}
                    recording={rec}
                    view="list"
                    onDelete={setDeleteId}
                    onEdit={handleEdit}
                    onDownload={handleDownload}
                    onClick={() => navigate('/library')}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                className="flex items-center justify-between pt-5 mt-4"
                style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}
              >
                <p className="text-sm text-slate-500">
                  Showing {(page - 1) * PAGE_LIMIT + 1}–{Math.min(page * PAGE_LIMIT, total)} of{' '}
                  {total}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm text-slate-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:text-slate-200"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </button>

                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                      const p = i + Math.max(1, page - 2);
                      return p <= totalPages ? (
                        <button
                          key={p}
                          onClick={() => setPage(p)}
                          className={cn(
                            'h-9 w-9 rounded-xl text-sm font-medium transition-all',
                            p === page ? 'text-white' : 'text-slate-500 hover:text-slate-300',
                          )}
                          style={
                            p === page
                              ? {
                                  background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                                  boxShadow: '0 2px 8px rgba(124,58,237,0.4)',
                                }
                              : {
                                  background: 'rgba(255,255,255,0.04)',
                                  border: '1px solid rgba(255,255,255,0.07)',
                                }
                          }
                        >
                          {p}
                        </button>
                      ) : null;
                    })}
                  </div>

                  <button
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm text-slate-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:text-slate-200"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        ) : (
          /* Empty state */
          <motion.div
            key="empty"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center py-28 text-center rounded-2xl"
            style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div
              className="h-16 w-16 rounded-2xl flex items-center justify-center mb-4"
              style={{
                background: 'rgba(139,92,246,0.1)',
                border: '1px solid rgba(139,92,246,0.15)',
              }}
            >
              <Search className="h-7 w-7 text-violet-400" />
            </div>
            <h3 className="text-base font-semibold text-slate-300 mb-1">
              {debouncedQ ? 'No recordings found' : 'No recordings yet'}
            </h3>
            <p className="text-sm text-slate-500 mb-6 max-w-xs">
              {debouncedQ
                ? `No recordings match "${debouncedQ}"`
                : 'Install the SnapTrace extension and start your first recording'}
            </p>
            {debouncedQ ? (
              <button
                onClick={() => {
                  setSearch('');
                  setDebouncedQ('');
                }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-300 transition-colors hover:text-slate-100"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.09)',
                }}
              >
                Clear search
              </button>
            ) : (
              <button
                onClick={() => window.open('https://snaptrace.app', '_blank')}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5"
                style={{
                  background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                  boxShadow: '0 4px 14px rgba(124,58,237,0.35)',
                }}
              >
                <Plus className="h-4 w-4" />
                Get extension
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete confirmation modal */}
      <Modal
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title="Delete recording"
        description="This action cannot be undone. The recording and all its data will be permanently deleted."
        size="sm"
      >
        <ModalFooter>
          <Button variant="secondary" onClick={() => setDeleteId(null)}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleting} onClick={handleDelete}>
            Delete
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
