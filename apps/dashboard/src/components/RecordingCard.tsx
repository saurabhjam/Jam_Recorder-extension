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

  if (view === 'list') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="card card-hover flex items-center gap-4 px-4 py-3 group"
      >
        {/* Thumbnail */}
        <div
          className="relative flex-shrink-0 w-24 h-14 rounded-lg overflow-hidden bg-gray-800 cursor-pointer"
          onClick={() => onClick?.(recording.id)}
        >
          {recording.thumbnailUrl ? (
            <img
              src={recording.thumbnailUrl}
              alt={recording.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Play className="h-5 w-5 text-gray-600" />
            </div>
          )}
          {recording.duration && (
            <span className="absolute bottom-1 right-1 text-[10px] font-mono font-medium bg-black/80 text-white px-1.5 py-0.5 rounded">
              {formatDuration(recording.duration)}
            </span>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
            <Play className="h-4 w-4 text-white" />
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
            <p
              className="text-sm font-medium text-gray-200 truncate cursor-pointer hover:text-violet-300 transition-colors"
              onClick={() => onClick?.(recording.id)}
            >
              {recording.title}
            </p>
          )}
          <p className="text-xs text-gray-500 mt-0.5">{formatRelativeDate(recording.createdAt)}</p>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge variant={typeBadge[recording.type] ?? 'default'}>
            {typeIcons[recording.type]} {recording.type}
          </Badge>
          <Badge variant={statusVariant[recording.status] ?? 'default'} dot>
            {recording.status}
          </Badge>
        </div>

        {/* Views */}
        <div className="flex items-center gap-1 text-xs text-gray-500 flex-shrink-0 w-16 text-right">
          <Eye className="h-3 w-3" />
          {recording.viewCount}
        </div>

        {/* Actions */}
        <ActionsMenu
          recording={recording}
          onCopy={handleCopyLink}
          onEdit={() => setEditingTitle(true)}
          onDelete={() => onDelete?.(recording.id)}
          onDownload={() => onDownload?.(recording.id)}
        />
      </motion.div>
    );
  }

  // Grid card
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ y: -2 }}
      className="card card-hover group overflow-hidden cursor-pointer"
      onClick={() => onClick?.(recording.id)}
    >
      {/* Thumbnail */}
      <div className="relative h-40 bg-gray-800 overflow-hidden">
        {recording.thumbnailUrl ? (
          <img
            src={recording.thumbnailUrl}
            alt={recording.title}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Play className="h-8 w-8 text-gray-600" />
          </div>
        )}

        {/* Overlay */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <div className="bg-white/20 backdrop-blur-sm rounded-full p-3">
            <Play className="h-5 w-5 text-white" />
          </div>
        </div>

        {/* Duration badge */}
        {recording.duration && (
          <span className="absolute bottom-2 right-2 text-xs font-mono font-medium bg-black/80 text-white px-2 py-0.5 rounded">
            {formatDuration(recording.duration)}
          </span>
        )}

        {/* Status */}
        {recording.status !== 'READY' && (
          <div className="absolute top-2 left-2">
            <Badge variant={statusVariant[recording.status] ?? 'default'} dot>
              {recording.status}
            </Badge>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4 space-y-3">
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
            className="input-base text-sm py-1 px-2 w-full"
          />
        ) : (
          <p className="text-sm font-medium text-gray-200 truncate leading-snug">
            {recording.title}
          </p>
        )}

        {/* Badges row */}
        <div className="flex items-center gap-2">
          <Badge variant={typeBadge[recording.type] ?? 'default'} size="sm">
            {typeIcons[recording.type]}
            {recording.type}
          </Badge>
        </div>

        {/* Meta row */}
        <div className="flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {recording.viewCount}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatRelativeDate(recording.createdAt)}
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
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Actions Menu ──────────────────────────────────────────────────────────────

interface ActionsMenuProps {
  recording: Recording;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDownload: () => void;
}

function ActionsMenu({ recording, onCopy, onEdit, onDelete, onDownload }: ActionsMenuProps) {
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownTrigger>
      <DropdownContent align="end">
        <DropdownItem icon={<Copy className="h-3.5 w-3.5" />} onSelect={onCopy}>
          Copy share link
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
          Delete recording
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
