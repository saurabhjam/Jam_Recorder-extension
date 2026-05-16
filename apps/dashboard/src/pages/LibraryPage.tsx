import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Grid3X3, List, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { RecordingCard } from '@components/RecordingCard';
import { SkeletonRecordingCard } from '@components/Skeleton';
import { Button } from '@components/ui/Button';
import { Badge } from '@components/ui/Badge';
import { Tabs, TabsList, TabsTrigger } from '@components/ui/Tabs';
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

const TYPE_TABS: Array<{ label: string; value: RecordingTypeDB | 'ALL' }> = [
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

  return (
    <div className="space-y-5 max-w-[1400px] mx-auto">
      {/* ── Header ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Library</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {total > 0 ? `${total} recording${total !== 1 ? 's' : ''}` : 'All your recordings'}
          </p>
        </div>
      </div>

      {/* ── Filter bar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-0 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 pointer-events-none" />
          <input
            type="search"
            placeholder="Search recordings..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              handleSearch(e.target.value);
            }}
            className="input-base pl-9 h-9 w-full"
          />
        </div>

        {/* Type tabs */}
        <Tabs
          value={typeFilter}
          onValueChange={(v) => {
            setTypeFilter(v as typeof typeFilter);
            setPage(1);
          }}
        >
          <TabsList variant="pills" className="flex-shrink-0">
            {TYPE_TABS.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                variant="pills"
                className="text-xs px-3 py-1.5"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex-1" />

        {/* Sort */}
        <Dropdown>
          <DropdownTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<SlidersHorizontal className="h-3.5 w-3.5" />}
            >
              {sort.label}
            </Button>
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
        <div className="flex items-center bg-gray-800 border border-white/[0.06] rounded-lg p-1 gap-0.5">
          <button
            onClick={() => setView('grid')}
            className={cn(
              'p-1.5 rounded transition-colors',
              view === 'grid' ? 'bg-gray-700 text-gray-100' : 'text-gray-500 hover:text-gray-300',
            )}
          >
            <Grid3X3 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setView('list')}
            className={cn(
              'p-1.5 rounded transition-colors',
              view === 'list' ? 'bg-gray-700 text-gray-100' : 'text-gray-500 hover:text-gray-300',
            )}
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────── */}
      {isLoading ? (
        view === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <SkeletonRecordingCard key={i} />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="card p-4 flex items-center gap-4 animate-pulse">
                <div className="h-12 w-20 rounded-lg bg-white/[0.04]" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 rounded bg-white/[0.04]" />
                  <div className="h-3 w-1/4 rounded bg-white/[0.04]" />
                </div>
              </div>
            ))}
          </div>
        )
      ) : recordings.length > 0 ? (
        <>
          {view === 'grid' ? (
            <div
              className={cn(
                'grid gap-4',
                'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
                isFetching && 'opacity-70 pointer-events-none',
              )}
            >
              {recordings.map((rec) => (
                <RecordingCard
                  key={rec.id}
                  recording={rec}
                  view="grid"
                  onDelete={setDeleteId}
                  onEdit={handleEdit}
                  onDownload={handleDownload}
                  onClick={() => navigate('/library')}
                />
              ))}
            </div>
          ) : (
            <div className={cn('space-y-2', isFetching && 'opacity-70 pointer-events-none')}>
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
            <div className="flex items-center justify-between pt-4 border-t border-white/[0.06]">
              <p className="text-sm text-gray-500">
                Showing {(page - 1) * PAGE_LIMIT + 1}–{Math.min(page * PAGE_LIMIT, total)} of{' '}
                {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  leftIcon={<ChevronLeft className="h-4 w-4" />}
                >
                  Prev
                </Button>
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                    const p = i + Math.max(1, page - 2);
                    return p <= totalPages ? (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={cn(
                          'h-8 w-8 rounded-lg text-sm transition-colors',
                          p === page
                            ? 'bg-violet-600 text-white'
                            : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]',
                        )}
                      >
                        {p}
                      </button>
                    ) : null;
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  rightIcon={<ChevronRight className="h-4 w-4" />}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="h-16 w-16 rounded-2xl bg-violet-400/10 flex items-center justify-center mb-4">
            <Search className="h-7 w-7 text-violet-400" />
          </div>
          <h3 className="text-base font-medium text-gray-300 mb-1">
            {debouncedQ ? 'No recordings found' : 'No recordings yet'}
          </h3>
          <p className="text-sm text-gray-500">
            {debouncedQ ? `No recordings match "${debouncedQ}"` : 'Start recording with SnapTrace'}
          </p>
          {debouncedQ && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              onClick={() => {
                setSearch('');
                setDebouncedQ('');
              }}
            >
              Clear search
            </Button>
          )}
        </div>
      )}

      {/* ── Delete confirmation modal ──────────────────────────────── */}
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
