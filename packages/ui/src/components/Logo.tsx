import React from 'react';
import { Zap } from 'lucide-react';
import { cn } from '../utils/cn';

// ─── Types ────────────────────────────────────────────────────────────────────

type LogoSize = 'sm' | 'md' | 'lg';

interface LogoProps {
  size?: LogoSize;
  showIcon?: boolean;
  className?: string;
}

// ─── Size map ─────────────────────────────────────────────────────────────────

const sizeMap: Record<LogoSize, { icon: string; iconBox: string; text: string }> = {
  sm: { icon: 'h-3 w-3', iconBox: 'h-6  w-6  rounded-lg', text: 'text-sm font-bold' },
  md: { icon: 'h-4 w-4', iconBox: 'h-8  w-8  rounded-xl', text: 'text-lg font-bold' },
  lg: { icon: 'h-5.5 w-5.5', iconBox: 'h-11 w-11 rounded-2xl', text: 'text-2xl font-bold' },
};

// ─── Component ────────────────────────────────────────────────────────────────

export function Logo({ size = 'md', showIcon = true, className }: LogoProps) {
  const s = sizeMap[size];

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {showIcon && (
        <div
          className={cn(
            'flex-shrink-0 flex items-center justify-center',
            'bg-gradient-to-br from-violet-600 to-blue-500',
            'shadow-lg shadow-violet-500/20',
            s.iconBox,
          )}
        >
          <Zap className={cn('text-white', s.icon)} />
        </div>
      )}
      <span
        className={cn(
          'tracking-tight bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent',
          s.text,
        )}
      >
        SnapTrace
      </span>
    </div>
  );
}
