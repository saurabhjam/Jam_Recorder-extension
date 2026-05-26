import React, { useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download,
  Copy,
  MessageCircle,
  Eye,
  Calendar,
  Video,
  Send,
  ExternalLink,
  Monitor,
  Globe,
  Layers,
  Terminal,
  Wifi,
  Zap,
  Server,
  Search,
  ChevronDown,
  ChevronRight,
  MousePointer,
  Navigation,
  Keyboard,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  Clock,
  Link,
  Maximize2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { VideoPlayer } from '@components/VideoPlayer';
import { Button } from '@components/ui/Button';
import { Badge } from '@components/ui/Badge';
import {
  useSharedRecording,
  useComments,
  useCreateComment,
  useReactions,
  useToggleReaction,
} from '@hooks/useRecordings';
import { api } from '@services/api';
import {
  formatDate,
  formatRelativeDate,
  formatDuration,
  formatBytes,
  getInitials,
  copyToClipboard,
  buildShareUrl,
  cn,
  truncate,
} from '@utils/index';
import type { ConsoleLogs, NetworkLog } from '@snaptrace/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const REACTIONS = [
  { emoji: '👍', label: 'Like' },
  { emoji: '❤️', label: 'Love' },
  { emoji: '😂', label: 'Funny' },
  { emoji: '😮', label: 'Wow' },
  { emoji: '🤔', label: 'Thinking' },
  { emoji: '🐛', label: 'Bug' },
];

type RightTab = 'info' | 'console' | 'network' | 'actions' | 'backend';

interface ActionEvent {
  type: 'click' | 'navigate' | 'type' | 'scroll';
  description: string;
  timestamp: number;
}

// ─── Level badge helpers ──────────────────────────────────────────────────────

const CONSOLE_LEVEL_STYLES: Record<string, string> = {
  log: 'bg-gray-700/60 text-gray-300 border-gray-600/30',
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  warn: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  error: 'bg-red-500/15 text-red-400 border-red-500/25',
  debug: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
};

const CONSOLE_ROW_STYLES: Record<string, string> = {
  log: '',
  info: 'bg-blue-500/[0.03]',
  warn: 'bg-amber-500/[0.04] border-l-2 border-amber-500/30',
  error: 'bg-red-500/[0.04] border-l-2 border-red-500/30',
  debug: 'bg-purple-500/[0.03]',
};

function getStatusColor(status: number): string {
  if (status >= 200 && status < 300) return 'text-emerald-400';
  if (status >= 400 && status < 500) return 'text-amber-400';
  if (status >= 500) return 'text-red-400';
  return 'text-gray-400';
}

function getStatusBg(status: number): string {
  if (status >= 200 && status < 300) return 'bg-emerald-400/10 border-emerald-400/20';
  if (status >= 400 && status < 500) return 'bg-amber-400/10 border-amber-400/20';
  if (status >= 500) return 'bg-red-400/10 border-red-400/20';
  return 'bg-gray-700/60 border-gray-600/30';
}

function getActionIcon(type: ActionEvent['type']) {
  switch (type) {
    case 'click':
      return <MousePointer className="h-3.5 w-3.5" />;
    case 'navigate':
      return <Navigation className="h-3.5 w-3.5" />;
    case 'type':
      return <Keyboard className="h-3.5 w-3.5" />;
    case 'scroll':
      return <Layers className="h-3.5 w-3.5" />;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="h-10 w-10 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center mb-3">
        <Info className="h-5 w-5 text-gray-600" />
      </div>
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}

function SearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Search…'}
        className="w-full pl-8 pr-3 py-2 bg-white/[0.04] border border-white/[0.07] rounded-lg text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500/40 focus:border-violet-500/30 transition-all"
      />
    </div>
  );
}

// ─── Info Tab ─────────────────────────────────────────────────────────────────

function InfoTab({
  recording,
}: {
  recording: NonNullable<ReturnType<typeof useSharedRecording>['data']>;
}) {
  const meta = recording.metadata;

  const rows: Array<{ icon: React.ReactNode; label: string; value: string | undefined | null }> = [
    {
      icon: <Monitor className="h-3.5 w-3.5" />,
      label: 'Browser',
      value: meta?.browser
        ? `${meta.browser}${meta.browserVersion ? ` ${meta.browserVersion}` : ''}`
        : undefined,
    },
    {
      icon: <Layers className="h-3.5 w-3.5" />,
      label: 'OS',
      value: meta?.os ? `${meta.os}${meta.osVersion ? ` ${meta.osVersion}` : ''}` : undefined,
    },
    { icon: <Globe className="h-3.5 w-3.5" />, label: 'URL', value: meta?.url },
    {
      icon: <Maximize2 className="h-3.5 w-3.5" />,
      label: 'Viewport',
      value: meta?.screenResolution,
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: 'FPS',
      value: meta?.fps ? `${meta.fps} fps` : undefined,
    },
    {
      icon: <Calendar className="h-3.5 w-3.5" />,
      label: 'Recorded',
      value: formatDate(recording.createdAt),
    },
    { icon: <Eye className="h-3.5 w-3.5" />, label: 'Views', value: String(recording.viewCount) },
    {
      icon: <Video className="h-3.5 w-3.5" />,
      label: 'Duration',
      value: recording.duration ? formatDuration(recording.duration) : undefined,
    },
    {
      icon: <Layers className="h-3.5 w-3.5" />,
      label: 'File size',
      value: recording.size ? formatBytes(recording.size) : undefined,
    },
  ];

  return (
    <div className="p-4 space-y-1">
      {rows.map((row) => {
        if (!row.value) return null;
        return (
          <div
            key={row.label}
            className="flex items-start gap-3 py-2.5 border-b border-white/[0.04] last:border-0"
          >
            <span className="text-gray-500 mt-0.5 flex-shrink-0">{row.icon}</span>
            <span className="text-xs text-gray-500 w-20 flex-shrink-0 pt-px">{row.label}</span>
            <span
              className="text-xs text-gray-300 break-all leading-relaxed flex-1"
              title={row.value}
            >
              {row.label === 'URL' ? (
                <a
                  href={row.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-400 hover:text-violet-300 underline underline-offset-2 flex items-center gap-1"
                >
                  {truncate(row.value, 40)}
                  <ExternalLink className="h-3 w-3 flex-shrink-0" />
                </a>
              ) : (
                row.value
              )}
            </span>
          </div>
        );
      })}
      {!meta && <EmptyState label="No environment info captured" />}
    </div>
  );
}

// ─── Console Tab ──────────────────────────────────────────────────────────────

function ConsoleTab({ logs, onSeek }: { logs: ConsoleLogs[]; onSeek: (t: number) => void }) {
  const [search, setSearch] = useState('');
  const [filterLevel, setFilterLevel] = useState<string>('all');

  const levels = ['all', 'log', 'info', 'warn', 'error', 'debug'];

  const filtered = logs.filter((l) => {
    const matchLevel = filterLevel === 'all' || l.level === filterLevel;
    const matchSearch = !search || l.message.toLowerCase().includes(search.toLowerCase());
    return matchLevel && matchSearch;
  });

  if (!logs.length) return <EmptyState label="No console logs captured" />;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="p-3 border-b border-white/[0.06] space-y-2">
        <SearchBar value={search} onChange={setSearch} placeholder="Filter logs…" />
        <div className="flex gap-1 flex-wrap">
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setFilterLevel(l)}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors capitalize',
                filterLevel === l
                  ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent hover:border-white/[0.08]',
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {filtered.length === 0 ? (
          <EmptyState label="No matching logs" />
        ) : (
          filtered.map((log, i) => (
            <div
              key={i}
              onClick={() => onSeek(log.timestamp / 1000)}
              className={cn(
                'flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.04] transition-colors group',
                CONSOLE_ROW_STYLES[log.level] ?? '',
              )}
              title="Click to seek video"
            >
              {/* Timestamp */}
              <span className="text-gray-600 flex-shrink-0 tabular-nums mt-0.5 group-hover:text-gray-400 transition-colors">
                {formatDuration(log.timestamp / 1000)}
              </span>
              {/* Level badge */}
              <span
                className={cn(
                  'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase flex-shrink-0',
                  CONSOLE_LEVEL_STYLES[log.level] ?? CONSOLE_LEVEL_STYLES.log,
                )}
              >
                {log.level}
              </span>
              {/* Message */}
              <span className="text-gray-300 break-all leading-relaxed flex-1 min-w-0">
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Network Tab ──────────────────────────────────────────────────────────────

function NetworkTab({ logs, onSeek }: { logs: NetworkLog[]; onSeek: (t: number) => void }) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = logs.filter(
    (l) =>
      !search ||
      l.url.toLowerCase().includes(search.toLowerCase()) ||
      l.method.toLowerCase().includes(search.toLowerCase()),
  );

  if (!logs.length) return <EmptyState label="No network requests captured" />;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="p-3 border-b border-white/[0.06]">
        <SearchBar value={search} onChange={setSearch} placeholder="Filter by URL or method…" />
      </div>

      {/* Header row */}
      <div className="grid grid-cols-[52px_1fr_48px_64px] gap-2 px-3 py-1.5 border-b border-white/[0.04] text-[10px] text-gray-600 uppercase tracking-wider">
        <span>Method</span>
        <span>URL</span>
        <span className="text-right">Status</span>
        <span className="text-right">Time</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto text-xs">
        {filtered.length === 0 ? (
          <EmptyState label="No matching requests" />
        ) : (
          filtered.map((req, i) => (
            <div key={i}>
              <div
                onClick={() => {
                  setExpanded(expanded === i ? null : i);
                  onSeek(req.timestamp / 1000);
                }}
                className="grid grid-cols-[52px_1fr_48px_64px] gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.04] transition-colors items-center"
              >
                {/* Method */}
                <span
                  className={cn(
                    'font-mono font-semibold text-[10px]',
                    req.method === 'GET'
                      ? 'text-emerald-400'
                      : req.method === 'POST'
                        ? 'text-blue-400'
                        : req.method === 'PUT' || req.method === 'PATCH'
                          ? 'text-amber-400'
                          : req.method === 'DELETE'
                            ? 'text-red-400'
                            : 'text-gray-400',
                  )}
                >
                  {req.method}
                </span>

                {/* URL */}
                <span className="text-gray-300 truncate" title={req.url}>
                  {truncate(req.url, 50)}
                </span>

                {/* Status */}
                <span
                  className={cn('text-right font-mono font-medium', getStatusColor(req.status))}
                >
                  {req.status}
                </span>

                {/* Duration */}
                <span className="text-right text-gray-500 font-mono tabular-nums">
                  {req.duration < 1000
                    ? `${Math.round(req.duration)}ms`
                    : `${(req.duration / 1000).toFixed(1)}s`}
                </span>
              </div>

              {/* Expanded detail */}
              <AnimatePresence>
                {expanded === i && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <div className="mx-3 mb-2 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06] space-y-2 text-xs font-mono">
                      <div className="flex justify-between text-gray-500">
                        <span>Full URL</span>
                        <span className="text-gray-300 break-all text-right max-w-[70%]">
                          {req.url}
                        </span>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <span>Status</span>
                        <span className={getStatusColor(req.status)}>{req.status}</span>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <span>Duration</span>
                        <span className="text-gray-300">{req.duration}ms</span>
                      </div>
                      {req.size > 0 && (
                        <div className="flex justify-between text-gray-500">
                          <span>Size</span>
                          <span className="text-gray-300">{formatBytes(req.size)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-gray-500">
                        <span>Type</span>
                        <span className="text-gray-300">{req.type}</span>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <span>Timestamp</span>
                        <span className="text-gray-300">
                          {formatDuration(req.timestamp / 1000)}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Actions Tab ──────────────────────────────────────────────────────────────

function ActionsTab({ logs, onSeek }: { logs: ConsoleLogs[]; onSeek: (t: number) => void }) {
  // Derive synthetic action events from console logs tagged with user actions,
  // or surface a "no data" state if none.
  const actions: ActionEvent[] = logs
    .filter((l) => {
      const msg = l.message.toLowerCase();
      return (
        msg.includes('click') ||
        msg.includes('navigate') ||
        msg.includes('input') ||
        msg.includes('type') ||
        msg.includes('scroll') ||
        msg.includes('submit')
      );
    })
    .map((l) => {
      const msg = l.message.toLowerCase();
      let type: ActionEvent['type'] = 'click';
      if (msg.includes('navigate') || msg.includes('url')) type = 'navigate';
      else if (msg.includes('input') || msg.includes('type')) type = 'type';
      else if (msg.includes('scroll')) type = 'scroll';
      return { type, description: l.message, timestamp: l.timestamp };
    });

  if (!actions.length) return <EmptyState label="No user actions captured" />;

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-1">
      {actions.map((a, i) => (
        <div
          key={i}
          onClick={() => onSeek(a.timestamp / 1000)}
          className="flex items-start gap-3 p-2.5 rounded-lg cursor-pointer hover:bg-white/[0.04] transition-colors group"
        >
          <div className="h-6 w-6 rounded-md bg-white/[0.06] border border-white/[0.08] flex items-center justify-center flex-shrink-0 text-gray-400 group-hover:text-violet-400 transition-colors">
            {getActionIcon(a.type)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-300 truncate">{a.description}</p>
            <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
              {formatDuration(a.timestamp / 1000)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Backend Tab ──────────────────────────────────────────────────────────────

function BackendTab({ logs, onSeek }: { logs: ConsoleLogs[]; onSeek: (t: number) => void }) {
  // Filter logs that look like backend / server logs
  const serverLogs = logs.filter((l) => {
    const msg = l.message.toLowerCase();
    return (
      msg.includes('server') ||
      msg.includes('api') ||
      msg.includes('request') ||
      msg.includes('response') ||
      msg.includes('db') ||
      msg.includes('sql') ||
      msg.includes('query') ||
      l.source === 'server'
    );
  });

  if (!serverLogs.length) return <EmptyState label="No backend logs captured" />;

  return (
    <div className="flex-1 overflow-y-auto font-mono text-xs">
      {serverLogs.map((log, i) => (
        <div
          key={i}
          onClick={() => onSeek(log.timestamp / 1000)}
          className={cn(
            'flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.04] transition-colors group',
            CONSOLE_ROW_STYLES[log.level] ?? '',
          )}
        >
          <span className="text-gray-600 flex-shrink-0 tabular-nums mt-0.5 group-hover:text-gray-400 transition-colors">
            {formatDuration(log.timestamp / 1000)}
          </span>
          <span
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase flex-shrink-0',
              CONSOLE_LEVEL_STYLES[log.level] ?? CONSOLE_LEVEL_STYLES.log,
            )}
          >
            {log.level}
          </span>
          <span className="text-gray-300 break-all leading-relaxed flex-1 min-w-0">
            {log.message}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Right Panel Tabs config ──────────────────────────────────────────────────

interface TabConfig {
  id: RightTab;
  label: string;
  icon: React.ReactNode;
}

const TAB_CONFIG: TabConfig[] = [
  { id: 'info', label: 'Info', icon: <Info className="h-3.5 w-3.5" /> },
  { id: 'console', label: 'Console', icon: <Terminal className="h-3.5 w-3.5" /> },
  { id: 'network', label: 'Network', icon: <Wifi className="h-3.5 w-3.5" /> },
  { id: 'actions', label: 'Actions', icon: <Zap className="h-3.5 w-3.5" /> },
  { id: 'backend', label: 'Backend', icon: <Server className="h-3.5 w-3.5" /> },
];

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { data: recording, isLoading, isFetching, error } = useSharedRecording(token ?? '');
  const { data: comments } = useComments(recording?.id ?? '');
  const { mutate: createComment, isPending: commenting } = useCreateComment(recording?.id ?? '');
  const { data: reactionData } = useReactions(recording?.id ?? '');
  const { mutate: toggleReaction } = useToggleReaction(recording?.id ?? '');

  const [commentText, setCommentText] = useState('');
  const [guestName, setGuestName] = useState(
    () => localStorage.getItem('snaptrace_guest_name') ?? '',
  );
  const isLoggedIn = !!localStorage.getItem('snaptrace_access_token');
  const [currentTime, setCurrentTime] = useState(0);
  const [activeTab, setActiveTab] = useState<RightTab>('info');

  const videoRef = useRef<{ seekTo?: (t: number) => void } | null>(null);

  const handleCopy = async () => {
    await copyToClipboard(buildShareUrl(token!));
    toast.success('Link copied to clipboard!');
  };

  const handleDownload = async () => {
    if (!recording?.allowDownload) return;
    try {
      const blob = await api.downloadRecording(recording.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${recording.title}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Download started');
    } catch {
      toast.error('Download failed');
    }
  };

  const handleComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    if (!isLoggedIn && !guestName.trim()) return;
    if (!isLoggedIn) localStorage.setItem('snaptrace_guest_name', guestName.trim());
    createComment(
      {
        content: commentText.trim(),
        timestamp: Math.floor(currentTime),
        ...(!isLoggedIn ? { guestName: guestName.trim() } : {}),
      },
      { onSuccess: () => setCommentText('') },
    );
  };

  const handleReaction = (emoji: string) => {
    if (!recording?.id) return;
    toggleReaction(emoji);
  };

  // Seek video from panel tab interactions
  const handleSeek = useCallback((timeSeconds: number) => {
    // We can't directly control the VideoPlayer ref here since it doesn't expose
    // an imperative handle, but we dispatch a custom event the player can listen to.
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = timeSeconds;
      video.play().catch(() => {});
    }
    toast(`Seeked to ${formatDuration(timeSeconds)}`, { icon: '⏱' });
  }, []);

  const consoleLogs = recording?.metadata?.consoleLogs ?? [];
  const networkLogs = recording?.metadata?.networkLogs ?? [];

  // ── Loading / retrying ───────────────────────────────────────────────────
  // Show spinner when: initial load OR when retrying a 404 (recording still uploading)

  if (isLoading || (error && isFetching)) {
    return (
      <div className="min-h-screen bg-[#060816] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading recording…</p>
        </div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────

  if (error || !recording) {
    return (
      <div className="min-h-screen bg-[#060816] flex flex-col items-center justify-center text-center px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <div className="h-16 w-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <Video className="h-8 w-8 text-red-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-200 mb-2">Recording not found</h1>
            <p className="text-gray-500 text-sm max-w-sm">
              This recording may have been deleted or the link has expired.
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  const shareUrl = buildShareUrl(token!);

  // ── Full layout ───────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#060816] flex flex-col overflow-hidden">
      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 h-14 border-b border-white/[0.06] glass-header flex items-center px-4 gap-3 z-30">
        {/* Logo */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
            <Video className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="font-bold text-sm bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent hidden sm:block">
            SnapTrace
          </span>
          <span className="text-gray-700 text-xs hidden sm:block">/</span>
          <span className="text-gray-400 text-xs hidden sm:block">Share</span>
        </div>

        {/* URL bar */}
        <div className="flex-1 min-w-0 flex items-center gap-2 mx-2">
          <div className="flex-1 min-w-0 flex items-center gap-2 bg-white/[0.04] border border-white/[0.07] rounded-lg px-3 py-1.5 max-w-xl">
            <Link className="h-3 w-3 text-gray-600 flex-shrink-0" />
            <span className="text-xs text-gray-400 truncate font-mono">{shareUrl}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Copy className="h-3.5 w-3.5" />}
            onClick={handleCopy}
          >
            <span className="hidden sm:inline">Copy link</span>
          </Button>
          {recording.allowDownload && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Download className="h-3.5 w-3.5" />}
              onClick={handleDownload}
            >
              <span className="hidden sm:inline">Download</span>
            </Button>
          )}
        </div>
      </header>

      {/* ── BODY: split panels ─────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── LEFT PANEL (60%) ─────────────────────────────────────────────── */}
        <div className="flex flex-col w-full lg:w-[60%] overflow-y-auto border-r border-white/[0.06]">
          {/* Video area */}
          <div className="p-4 pb-0">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
            >
              {recording.url ? (
                <VideoPlayer
                  src={recording.url}
                  poster={recording.thumbnailUrl ?? undefined}
                  title={recording.title}
                  onTimeUpdate={setCurrentTime}
                  className="w-full aspect-video rounded-xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
                />
              ) : (
                <div className="w-full aspect-video rounded-xl bg-gray-900/80 border border-white/[0.06] flex flex-col items-center justify-center">
                  {recording.status === 'PROCESSING' ? (
                    <>
                      <div className="h-10 w-10 border-2 border-violet-500 border-t-transparent rounded-full animate-spin mb-3" />
                      <p className="text-sm text-gray-400">Processing your recording…</p>
                    </>
                  ) : (
                    <>
                      <Video className="h-10 w-10 text-gray-600 mb-3" />
                      <p className="text-sm text-gray-500">Video unavailable</p>
                    </>
                  )}
                </div>
              )}
            </motion.div>
          </div>

          {/* Metadata below player */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.1 }}
            className="p-4 space-y-4"
          >
            {/* Title + badges */}
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <Badge variant="purple">{recording.type}</Badge>
                {recording.status === 'PROCESSING' && (
                  <Badge variant="warning" dot>
                    Processing
                  </Badge>
                )}
              </div>
              <h1 className="text-lg font-bold text-gray-100 leading-snug">{recording.title}</h1>
              {recording.description && (
                <p className="mt-1.5 text-sm text-gray-500 leading-relaxed">
                  {recording.description}
                </p>
              )}
            </div>

            {/* Author + stats row */}
            <div className="flex items-center gap-5 flex-wrap">
              {recording.user && (
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-full bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center text-xs font-semibold text-white flex-shrink-0 overflow-hidden">
                    {recording.user.avatar ? (
                      <img
                        src={recording.user.avatar}
                        alt={recording.user.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      getInitials(recording.user.name)
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-200">{recording.user.name}</p>
                    <p className="text-xs text-gray-600">Author</p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" /> {recording.viewCount}
                </span>
                {recording.duration && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {formatDuration(recording.duration)}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatDate(recording.createdAt)}
                </span>
              </div>
            </div>

            {/* Reactions */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {REACTIONS.map((r) => {
                const isActive = reactionData?.mine?.includes(r.emoji) ?? false;
                const count = reactionData?.counts?.[r.emoji] ?? 0;
                return (
                  <button
                    key={r.emoji}
                    onClick={() => handleReaction(r.emoji)}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm transition-all border',
                      isActive
                        ? 'bg-violet-600/20 border-violet-500/30 text-violet-300'
                        : 'bg-white/[0.04] border-white/[0.06] text-gray-400 hover:bg-white/[0.08] hover:text-gray-200',
                    )}
                    title={r.label}
                  >
                    {r.emoji}
                    {count > 0 && <span className="text-xs font-semibold ml-0.5">{count}</span>}
                  </button>
                );
              })}
            </div>

            {/* Divider */}
            <div className="border-t border-white/[0.05]" />

            {/* Comments */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-violet-400" />
                <h3 className="text-sm font-semibold text-gray-200">
                  Comments{comments?.length ? ` (${comments.length})` : ''}
                </h3>
              </div>

              {/* Comment input */}
              <form onSubmit={handleComment} className="flex flex-col gap-2">
                {!isLoggedIn && (
                  <input
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    placeholder="Your name (required)"
                    className="input-base text-sm"
                    maxLength={100}
                  />
                )}
                <div className="flex gap-2">
                  <input
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment…"
                    className="input-base flex-1 text-sm"
                  />
                  <Button
                    type="submit"
                    size="md"
                    disabled={!commentText.trim() || (!isLoggedIn && !guestName.trim())}
                    loading={commenting}
                    leftIcon={<Send className="h-3.5 w-3.5" />}
                  >
                    Send
                  </Button>
                </div>
              </form>

              {/* Comment list */}
              {comments && comments.length > 0 ? (
                <div className="space-y-3 max-h-72 overflow-y-auto no-scrollbar">
                  {comments.map((c) => (
                    <div key={c.id} className="flex gap-3">
                      <div className="h-7 w-7 rounded-full bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center text-xs font-semibold text-white flex-shrink-0">
                        {c.user ? getInitials(c.user.name) : getInitials(c.guestName ?? 'G')}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <p className="text-xs font-medium text-gray-300">
                            {c.user?.name ?? c.guestName ?? 'Guest'}
                          </p>
                          {c.timestamp != null && (
                            <Badge variant="default" size="sm">
                              {formatDuration(c.timestamp)}
                            </Badge>
                          )}
                          <span className="text-xs text-gray-600">
                            {formatRelativeDate(c.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm text-gray-400 leading-relaxed break-words">
                          {c.content}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-600 text-center py-6">
                  No comments yet. Be the first!
                </p>
              )}
            </div>
          </motion.div>
        </div>

        {/* ── RIGHT PANEL (40%) ─────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
          className="hidden lg:flex flex-col w-[40%] bg-[#07091a] overflow-hidden"
        >
          {/* Tab bar */}
          <div className="flex-shrink-0 border-b border-white/[0.06] overflow-x-auto no-scrollbar">
            <div className="flex min-w-max">
              {TAB_CONFIG.map((tab) => {
                const count =
                  tab.id === 'console'
                    ? consoleLogs.length
                    : tab.id === 'network'
                      ? networkLogs.length
                      : null;

                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 transition-all whitespace-nowrap',
                      activeTab === tab.id
                        ? 'border-violet-500 text-violet-300 bg-violet-500/[0.06]'
                        : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]',
                    )}
                  >
                    <span className={activeTab === tab.id ? 'text-violet-400' : 'text-gray-600'}>
                      {tab.icon}
                    </span>
                    {tab.label}
                    {count != null && count > 0 && (
                      <span
                        className={cn(
                          'ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold',
                          activeTab === tab.id
                            ? 'bg-violet-500/20 text-violet-300'
                            : 'bg-white/[0.06] text-gray-500',
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="flex-1 overflow-hidden flex flex-col"
              >
                {activeTab === 'info' && <InfoTab recording={recording} />}
                {activeTab === 'console' && <ConsoleTab logs={consoleLogs} onSeek={handleSeek} />}
                {activeTab === 'network' && <NetworkTab logs={networkLogs} onSeek={handleSeek} />}
                {activeTab === 'actions' && <ActionsTab logs={consoleLogs} onSeek={handleSeek} />}
                {activeTab === 'backend' && <BackendTab logs={consoleLogs} onSeek={handleSeek} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      </div>

      {/* Mobile-only bottom tab bar for right panel */}
      <div className="lg:hidden flex-shrink-0 border-t border-white/[0.06] bg-[#07091a]">
        <div className="flex overflow-x-auto no-scrollbar">
          {TAB_CONFIG.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex-1 min-w-[64px] flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors',
                activeTab === tab.id ? 'text-violet-400' : 'text-gray-600',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Mobile panel content */}
        <div className="max-h-64 overflow-hidden flex flex-col border-t border-white/[0.04]">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="flex-1 overflow-hidden flex flex-col"
            >
              {activeTab === 'info' && <InfoTab recording={recording} />}
              {activeTab === 'console' && <ConsoleTab logs={consoleLogs} onSeek={handleSeek} />}
              {activeTab === 'network' && <NetworkTab logs={networkLogs} onSeek={handleSeek} />}
              {activeTab === 'actions' && <ActionsTab logs={consoleLogs} onSeek={handleSeek} />}
              {activeTab === 'backend' && <BackendTab logs={consoleLogs} onSeek={handleSeek} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
