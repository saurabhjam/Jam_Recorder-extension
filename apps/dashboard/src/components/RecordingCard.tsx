import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Play,
  MoreHorizontal,
  Copy,
  Pencil,
  Trash2,
  Download,
  Eye,
  Clock,
  Monitor,
  Globe,
  Camera,
  Image as ImageIcon,
  ExternalLink,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Badge } from '@components/ui/Badge';
import {
  Dropdown,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
} from '@components/ui/Dropdown';
import {
  cn,
  formatDuration,
  formatRelativeDate,
  buildShareUrl,
  copyToClipboard,
} from '@utils/index';
import type { Recording } from '@snaptrace/types';

const typeIcons: Record<string, React.ReactNode> = {
  SCREEN: <Monitor className="h-3 w-3" />,
  TAB: <Globe className="h-3 w-3" />,
  WEBCAM: <Camera className="h-3 w-3" />,
  SCREENSHOT: <ImageIcon className="h-3 w-3" />,
};

const typeColors: Record<string, { bg: string; text: string; border: string }> = {
  SCREEN: {
    bg: 'rgba(96,165,250,0.12)',
    text: '#93c5fd',
    border: 'rgba(96,165,250,0.2)',
  },
  TAB: {
    bg: 'rgba(52,211,153,0.12)',
    text: '#6ee7b7',
    border: 'rgba(52,211,153,0.2)',
  },
  WEBCAM: {
    bg: 'rgba(251,191,36,0.12)',
    text: '#fcd34d',
    border: 'rgba(251,191,36,0.2)',
  },
  SCREENSHOT: {
    bg: 'rgba(167,139,250,0.12)',
    text: '#c4b5fd',
    border: 'rgba(167,139,250,0.2)',
  },
};

const typeBadge: Record<string, 'info' | 'success' | 'warning' | 'purple'> = {
  SCREEN: 'info',
  TAB: 'success',
  WEBCAM: 'warning',
  SCREENSHOT: 'purple',
};

interface RecordingCardProps {
  recording: Recording;
  onDelete?: (id: string) => void;
  onEdit?: (id: string, title: string) => void;
  onDownload?: (id: string) => void;
  onClick?: (id: string) => void;
  view?: 'grid' | 'list';
}

export function RecordingCard({
  recording,
  onDelete,
  onEdit,
  onDownload,
  onClick,
  view = 'grid',
}: RecordingCardProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(recording.title);
  const [imgLoaded, setImgLoaded] = useState(false);

  const handleCopyLink = async () => {
    await copyToClipboard(buildShareUrl(recording.shareId));
    toast.success('Link copied!');
  };

  const handleTitleSubmit = () => {
    if (titleValue.trim() && titleValue !== recording.title) {
      onEdit?.(recording.id, titleValue.trim());
    } else {
      setTitleValue(recording.title);
    }
    setEditingTitle(false);
  };

  const statusVariant: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
    READY: 'success',
    PROCESSING: 'warning',
    UPLOADING: 'info',
    FAILED: 'danger',
  };

  const typeColor = typeColors[recording.type] ?? typeColors.SCREEN;

  // ──────────────────────────────────────────────────────────────
  // LIST VIEW
  // ──────────────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="group flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 cursor-pointer hover:-translate-y-px"
        style={{
          background:
            'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        }}
        onClick={() => onClick?.(recording.id)}
      >
        {/* Thumbnail */}
        <div
          className="relative flex-shrink-0 w-24 h-14 rounded-lg overflow-hidden"
          style={{ background: '#12172a' }}
        >
          {recording.thumbnailUrl ? (
            <img
              src={recording.thumbnailUrl}
              alt={recording.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Play className="h-5 w-5 text-slate-600" />
            </div>
          )}
          {recording.duration && (
            <span
              className="absolute bottom-1 right-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(0,0,0,0.85)', color: '#f1f5f9' }}
            >
              {formatDuration(recording.duration)}
            </span>
          )}
          <div
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: 'rgba(0,0,0,0.5)' }}
          >
            <div
              className="rounded-full p-1.5"
              style={{ background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(4px)' }}
            >
              <Play className="h-3.5 w-3.5 text-white" />
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              autoFocus
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleSubmit}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTitleSubmit();
                if (e.key === 'Escape') {
                  setTitleValue(recording.title);
                  setEditingTitle(false);
                }
              }}
              className="input-base text-sm py-1 px-2 w-full max-w-xs"
            />
          ) : (
            <p className="text-sm font-semibold text-slate-200 truncate group-hover:text-violet-300 transition-colors">
              {recording.title}
            </p>
          )}
          <p className="text-xs text-slate-500 mt-0.5">{formatRelativeDate(recording.createdAt)}</p>
        </div>

        {/* Type badge */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={{
              background: typeColor.bg,
              color: typeColor.text,
              border: `1px solid ${typeColor.border}`,
            }}
          >
            {typeIcons[recording.type]}
            {recording.type}
          </span>
          {recording.status !== 'READY' && (
            <Badge variant={statusVariant[recording.status] ?? 'default'} dot size="sm">
              {recording.status}
            </Badge>
          )}
        </div>

        {/* Views */}
        <div className="flex items-center gap-1 text-xs text-slate-500 flex-shrink-0 w-14">
          <Eye className="h-3.5 w-3.5" />
          {recording.viewCount}
        </div>

        {/* Actions */}
        <div onClick={(e) => e.stopPropagation()}>
          <ActionsMenu
            recording={recording}
            onCopy={handleCopyLink}
            onEdit={() => setEditingTitle(true)}
            onDelete={() => onDelete?.(recording.id)}
            onDownload={() => onDownload?.(recording.id)}
            onClick={() => onClick?.(recording.id)}
          />
        </div>
      </motion.div>
    );
  }

  // ──────────────────────────────────────────────────────────────
  // GRID VIEW
  // ──────────────────────────────────────────────────────────────
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ y: -3 }}
      className="group overflow-hidden rounded-2xl cursor-pointer transition-shadow duration-200"
      style={{
        background:
          'linear-gradient(160deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.018) 100%)',
        border: '1px solid rgba(255,255,255,0.07)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
      onClick={() => onClick?.(recording.id)}
    >
      {/* Thumbnail - 16:9 ratio */}
      <div className="relative overflow-hidden" style={{ paddingTop: '56.25%' /* 16:9 */ }}>
        <div className="absolute inset-0" style={{ background: '#0f1422' }}>
          {/* Loading skeleton */}
          {!imgLoaded && recording.thumbnailUrl && (
            <div
              className="absolute inset-0 animate-pulse"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            />
          )}
          {recording.thumbnailUrl ? (
            <img
              src={recording.thumbnailUrl}
              alt={recording.title}
              className={cn(
                'w-full h-full object-cover transition-all duration-500',
                imgLoaded ? 'opacity-100 scale-100' : 'opacity-0 scale-105',
                'group-hover:scale-105',
              )}
              onLoad={() => setImgLoaded(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <div
                className="rounded-2xl p-4"
                style={{
                  background: 'rgba(124,58,237,0.1)',
                  border: '1px solid rgba(124,58,237,0.15)',
                }}
              >
                <Play className="h-7 w-7 text-violet-400" />
              </div>
            </div>
          )}
        </div>

        {/* Hover overlay with play button */}
        <div
          className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200"
          style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
        >
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            whileHover={{ scale: 1.1 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex items-center justify-center rounded-full"
            style={{
              width: 48,
              height: 48,
              background: 'rgba(255,255,255,0.18)',
              backdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.2)',
            }}
          >
            <Play className="h-5 w-5 text-white ml-0.5" />
          </motion.div>
        </div>

        {/* Duration badge - bottom right */}
        {recording.duration && (
          <div className="absolute bottom-2 right-2">
            <span
              className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-md"
              style={{
                background: 'rgba(0,0,0,0.8)',
                backdropFilter: 'blur(4px)',
                color: '#f1f5f9',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              {formatDuration(recording.duration)}
            </span>
          </div>
        )}

        {/* Type badge - top left */}
        <div className="absolute top-2 left-2">
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
            style={{
              background: typeColor.bg,
              color: typeColor.text,
              border: `1px solid ${typeColor.border}`,
              backdropFilter: 'blur(4px)',
            }}
          >
            {typeIcons[recording.type]}
            {recording.type}
          </span>
        </div>

        {/* Status badge for non-ready */}
        {recording.status !== 'READY' && (
          <div className="absolute top-2 right-2">
            <Badge variant={statusVariant[recording.status] ?? 'default'} dot size="sm">
              {recording.status}
            </Badge>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4">
        {/* Title */}
        {editingTitle ? (
          <input
            autoFocus
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onBlur={handleTitleSubmit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTitleSubmit();
              if (e.key === 'Escape') {
                setTitleValue(recording.title);
                setEditingTitle(false);
              }
            }}
            className="input-base text-sm py-1 px-2 w-full mb-2"
          />
        ) : (
          <p className="text-sm font-semibold text-slate-200 truncate-2 leading-snug mb-3 group-hover:text-violet-300 transition-colors">
            {recording.title}
          </p>
        )}

        {/* Meta row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatRelativeDate(recording.createdAt)}
            </span>
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {recording.viewCount}
            </span>
          </div>

          {/* Actions dropdown */}
          <div onClick={(e) => e.stopPropagation()}>
            <ActionsMenu
              recording={recording}
              onCopy={handleCopyLink}
              onEdit={() => setEditingTitle(true)}
              onDelete={() => onDelete?.(recording.id)}
              onDownload={() => onDownload?.(recording.id)}
              onClick={() => onClick?.(recording.id)}
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Actions Menu ─────────────────────────────────────────────────────────────

interface ActionsMenuProps {
  recording: Recording;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onClick?: () => void;
}

function ActionsMenu({
  recording,
  onCopy,
  onEdit,
  onDelete,
  onDownload,
  onClick,
}: ActionsMenuProps) {
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 transition-colors"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.07)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownTrigger>
      <DropdownContent align="end">
        {onClick && (
          <DropdownItem icon={<ExternalLink className="h-3.5 w-3.5" />} onSelect={onClick}>
            View recording
          </DropdownItem>
        )}
        <DropdownItem icon={<Copy className="h-3.5 w-3.5" />} onSelect={onCopy}>
          Copy link
        </DropdownItem>
        <DropdownItem icon={<Pencil className="h-3.5 w-3.5" />} onSelect={onEdit}>
          Edit title
        </DropdownItem>
        {recording.allowDownload && (
          <DropdownItem icon={<Download className="h-3.5 w-3.5" />} onSelect={onDownload}>
            Download
          </DropdownItem>
        )}
        <DropdownSeparator />
        <DropdownItem icon={<Trash2 className="h-3.5 w-3.5" />} destructive onSelect={onDelete}>
          Delete
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
