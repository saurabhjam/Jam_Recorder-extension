import type { ReactNode } from 'react';
import { cn } from '@/utils';

type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'ghost';

type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-dark-700 text-dark-200 border-dark-600',
  primary: 'bg-jam-500/20 text-jam-300 border-jam-500/30',
  success: 'bg-green-500/20 text-green-300 border-green-500/30',
  warning: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  danger: 'bg-red-500/20 text-red-300 border-red-500/30',
  info: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  ghost: 'bg-white/5 text-dark-300 border-white/10',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-dark-300',
  primary: 'bg-jam-400',
  success: 'bg-green-400',
  warning: 'bg-amber-400',
  danger: 'bg-red-400',
  info: 'bg-blue-400',
  ghost: 'bg-dark-400',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-xs rounded-md',
  md: 'px-2.5 py-1 text-xs rounded-lg',
};

export function Badge({
  variant = 'default',
  size = 'md',
  children,
  dot = false,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-medium border',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotColors[variant])} />}
      {children}
    </span>
  );
}

// ─── Recording Status Badge ───────────────────────────────────────────────────

interface RecordingBadgeProps {
  isRecording: boolean;
  isPaused?: boolean;
}

export function RecordingBadge({ isRecording, isPaused }: RecordingBadgeProps) {
  if (!isRecording && !isPaused) return null;

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-red-500/20 text-red-300 border border-red-500/30">
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full bg-red-400',
          !isPaused && 'animate-recording-pulse',
        )}
      />
      {isPaused ? 'Paused' : 'Recording'}
    </span>
  );
}
