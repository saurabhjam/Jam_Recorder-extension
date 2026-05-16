import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Download,
  Copy,
  Heart,
  ThumbsUp,
  Smile,
  MessageCircle,
  Eye,
  Calendar,
  Video,
  Send,
  ExternalLink,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { VideoPlayer } from '@components/VideoPlayer';
import { Button } from '@components/ui/Button';
import { Badge } from '@components/ui/Badge';
import { useSharedRecording, useComments, useCreateComment } from '@hooks/useRecordings';
import { api } from '@services/api';
import {
  formatDate,
  formatRelativeDate,
  formatDuration,
  formatBytes,
  getInitials,
  copyToClipboard,
  buildShareUrl,
} from '@utils/index';

const REACTIONS = [
  { emoji: '👍', label: 'Like' },
  { emoji: '❤️', label: 'Love' },
  { emoji: '😂', label: 'Funny' },
  { emoji: '😮', label: 'Wow' },
  { emoji: '🤔', label: 'Thinking' },
  { emoji: '🐛', label: 'Bug' },
];

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { data: recording, isLoading, error } = useSharedRecording(token ?? '');
  const { data: comments } = useComments(recording?.id ?? '');
  const { mutate: createComment, isPending: commenting } = useCreateComment(recording?.id ?? '');

  const [commentText, setCommentText] = useState('');
  const [activeReaction, setActiveReaction] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const handleCopy = async () => {
    await copyToClipboard(buildShareUrl(token!));
    toast.success('Link copied!');
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
    } catch {
      toast.error('Download failed');
    }
  };

  const handleComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    createComment(
      { content: commentText.trim(), timestamp: Math.floor(currentTime) },
      { onSuccess: () => setCommentText('') },
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-violet-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !recording) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center text-center px-4">
        <div className="h-16 w-16 rounded-2xl bg-red-500/10 flex items-center justify-center mb-4">
          <Video className="h-8 w-8 text-red-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-200 mb-2">Recording not found</h1>
        <p className="text-gray-500 text-sm">
          This recording may have been deleted or the link has expired.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header gradient */}
      <div className="bg-gradient-to-b from-violet-950/50 via-gray-900/50 to-transparent">
        <div className="max-w-5xl mx-auto px-4 py-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Video className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent">
              SnapTrace
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Copy className="h-3.5 w-3.5" />}
              onClick={handleCopy}
            >
              Copy link
            </Button>
            {recording.allowDownload && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Download className="h-3.5 w-3.5" />}
                onClick={handleDownload}
              >
                Download
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 pb-16">
        {/* ── Video player ────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          {recording.url ? (
            <VideoPlayer
              src={recording.url}
              poster={recording.thumbnailUrl ?? undefined}
              title={recording.title}
              onTimeUpdate={setCurrentTime}
              className="w-full aspect-video rounded-2xl overflow-hidden shadow-[0_25px_60px_rgba(0,0,0,0.8)]"
            />
          ) : (
            <div className="w-full aspect-video rounded-2xl bg-gray-900 border border-white/[0.06] flex flex-col items-center justify-center">
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

        {/* ── Recording info ────────────────────────────────────── */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: details */}
          <div className="lg:col-span-2 space-y-5">
            {/* Title + badges */}
            <div>
              <div className="flex items-start gap-3 flex-wrap">
                <Badge variant="purple">{recording.type}</Badge>
                {recording.status === 'PROCESSING' && (
                  <Badge variant="warning" dot>
                    Processing
                  </Badge>
                )}
              </div>
              <h1 className="text-xl font-bold text-gray-100 mt-2 leading-snug">
                {recording.title}
              </h1>
              {recording.description && (
                <p className="mt-2 text-sm text-gray-400 leading-relaxed">
                  {recording.description}
                </p>
              )}
            </div>

            {/* Author + meta */}
            <div className="flex items-center gap-6 flex-wrap">
              {/* Author */}
              {recording.user && (
                <div className="flex items-center gap-2.5">
                  <div className="h-8 w-8 rounded-full bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center text-xs font-semibold text-white flex-shrink-0">
                    {recording.user.avatar ? (
                      <img
                        src={recording.user.avatar}
                        alt={recording.user.name}
                        className="w-full h-full object-cover rounded-full"
                      />
                    ) : (
                      getInitials(recording.user.name)
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-200">{recording.user.name}</p>
                    <p className="text-xs text-gray-500">Author</p>
                  </div>
                </div>
              )}

              {/* Stats */}
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" /> {recording.viewCount} views
                </span>
                {recording.duration && (
                  <span className="flex items-center gap-1">
                    <Video className="h-3.5 w-3.5" /> {formatDuration(recording.duration)}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatDate(recording.createdAt)}
                </span>
              </div>
            </div>

            {/* Reactions */}
            <div className="flex items-center gap-2">
              {REACTIONS.map((r) => (
                <button
                  key={r.emoji}
                  onClick={() => setActiveReaction(activeReaction === r.emoji ? null : r.emoji)}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm transition-all ${
                    activeReaction === r.emoji
                      ? 'bg-violet-600/20 border border-violet-500/30 text-violet-300'
                      : 'bg-white/[0.04] border border-white/[0.06] text-gray-400 hover:bg-white/[0.08] hover:text-gray-200'
                  }`}
                  title={r.label}
                >
                  {r.emoji}
                </button>
              ))}
            </div>

            {/* Comments */}
            <div className="card p-5 space-y-4">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-violet-400" />
                <h3 className="text-sm font-semibold text-gray-200">
                  Comments {comments?.length ? `(${comments.length})` : ''}
                </h3>
              </div>

              {/* Comment input */}
              <form onSubmit={handleComment} className="flex gap-2">
                <input
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Add a comment…"
                  className="input-base flex-1 text-sm"
                />
                <Button
                  type="submit"
                  size="md"
                  disabled={!commentText.trim()}
                  loading={commenting}
                  leftIcon={<Send className="h-3.5 w-3.5" />}
                >
                  Send
                </Button>
              </form>

              {/* Comment list */}
              {comments && comments.length > 0 ? (
                <div className="space-y-3 max-h-80 overflow-y-auto no-scrollbar">
                  {comments.map((c) => (
                    <div key={c.id} className="flex gap-3">
                      <div className="h-7 w-7 rounded-full bg-gradient-to-br from-violet-600 to-blue-500 flex items-center justify-center text-xs font-semibold text-white flex-shrink-0">
                        {c.user ? getInitials(c.user.name) : '?'}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-xs font-medium text-gray-300">
                            {c.user?.name ?? 'Anonymous'}
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
                        <p className="text-sm text-gray-400 leading-relaxed">{c.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-600 text-center py-4">
                  No comments yet. Be the first!
                </p>
              )}
            </div>
          </div>

          {/* Right: metadata card */}
          <div className="space-y-4">
            <div className="card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-gray-200">Details</h3>
              <div className="space-y-3 text-sm">
                {[
                  { label: 'Type', value: recording.type },
                  { label: 'Status', value: recording.status },
                  { label: 'Created', value: formatDate(recording.createdAt) },
                  ...(recording.duration
                    ? [{ label: 'Duration', value: formatDuration(recording.duration) }]
                    : []),
                  ...(recording.size
                    ? [{ label: 'File size', value: formatBytes(recording.size) }]
                    : []),
                  ...(recording.metadata?.browser
                    ? [{ label: 'Browser', value: recording.metadata.browser }]
                    : []),
                  ...(recording.metadata?.os
                    ? [{ label: 'OS', value: recording.metadata.os }]
                    : []),
                ].map((item) => (
                  <div key={item.label} className="flex justify-between">
                    <span className="text-gray-500">{item.label}</span>
                    <span className="text-gray-300 font-medium">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                leftIcon={<Copy className="h-4 w-4" />}
                onClick={handleCopy}
              >
                Copy link
              </Button>
              {recording.allowDownload && (
                <Button
                  variant="primary"
                  size="md"
                  className="w-full"
                  leftIcon={<Download className="h-4 w-4" />}
                  onClick={handleDownload}
                >
                  Download video
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
