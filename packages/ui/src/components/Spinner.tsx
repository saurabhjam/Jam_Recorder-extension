import React from 'react';
import { cn } from '../utils/cn';

// ─── Types ────────────────────────────────────────────────────────────────────

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface SpinnerProps {
  size?: SpinnerSize;
  color?: string;
  className?: string;
  label?: string;
}

// ─── Size map ─────────────────────────────────────────────────────────────────

const sizeMap: Record<SpinnerSize, string> = {
  xs: 'h-3 w-3',
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8',
  xl: 'h-12 w-12',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function Spinner({
  size = 'md',
  color = 'text-indigo-500',
  className,
  label,
}: SpinnerProps) {
  return (
    <div
      role="status"
      aria-label={label ?? 'Loading'}
      className={cn('inline-flex items-center justify-center gap-2', className)}
    >
      <svg
        className={cn('animate-spin', sizeMap[size], color)}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-20"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          className="opacity-80"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      {label && <span className="text-sm text-gray-400">{label}</span>}
    </div>
  );
}

// ─── Full-screen overlay ──────────────────────────────────────────────────────

export function FullscreenSpinner({ label }: { label?: string }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-gray-950/80 backdrop-blur-sm z-50">
      <div className="flex flex-col items-center gap-3">
        <Spinner size="lg" />
        {label && <p className="text-sm text-gray-400">{label}</p>}
      </div>
    </div>
  );
}
