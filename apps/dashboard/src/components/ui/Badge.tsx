import React from 'react';
import { cn } from '@utils/index';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'outline';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  dot?: boolean;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-gray-700/60 text-gray-300 border-gray-600/40',
  success: 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20',
  warning: 'bg-yellow-400/10 text-yellow-400 border-yellow-400/20',
  danger: 'bg-red-400/10 text-red-400 border-red-400/20',
  info: 'bg-blue-400/10 text-blue-400 border-blue-400/20',
  purple: 'bg-violet-600/15 text-violet-400 border-violet-500/25',
  outline: 'bg-transparent text-gray-400 border-gray-600/60',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-gray-400',
  success: 'bg-emerald-400',
  warning: 'bg-yellow-400',
  danger: 'bg-red-400',
  info: 'bg-blue-400',
  purple: 'bg-violet-400',
  outline: 'bg-gray-400',
};

export function Badge({
  variant = 'default',
  size = 'sm',
  dot,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'badge border',
        variantStyles[variant],
        size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-xs',
        className,
      )}
      {...rest}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColors[variant])} />}
      {children}
    </span>
  );
}
