import React from 'react';
import { cn } from '../utils/cn';

// ─── Types ────────────────────────────────────────────────────────────────────

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'purple' | 'danger';
type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}

// ─── Style maps ───────────────────────────────────────────────────────────────

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-white/[0.06] text-gray-400 border-white/[0.08]',
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warning: 'bg-amber-500/10   text-amber-400   border-amber-500/20',
  error: 'bg-red-500/10     text-red-400     border-red-500/20',
  danger: 'bg-red-500/10     text-red-400     border-red-500/20',
  info: 'bg-blue-500/10    text-blue-400    border-blue-500/20',
  purple: 'bg-violet-500/10  text-violet-400  border-violet-500/20',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-gray-500',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
  danger: 'bg-red-400',
  info: 'bg-blue-400',
  purple: 'bg-violet-400',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5 text-[10px] gap-1',
  md: 'px-2   py-0.5 text-xs     gap-1.5',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function Badge({
  variant = 'default',
  size = 'md',
  dot = false,
  children,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center font-medium rounded-full border',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
    >
      {dot && (
        <span
          className={cn(
            'rounded-full flex-shrink-0',
            dotColors[variant],
            size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
          )}
        />
      )}
      {children}
    </span>
  );
}
