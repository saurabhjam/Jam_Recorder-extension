import React from 'react';
import { cn } from '../utils/cn';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftAddon?: React.ReactNode;
  rightAddon?: React.ReactNode;
  className?: string;
  wrapperClassName?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    { label, error, hint, leftAddon, rightAddon, className, wrapperClassName, id, ...props },
    ref,
  ) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-gray-300">
            {label}
          </label>
        )}

        <div className="relative flex items-center">
          {leftAddon && (
            <div className="pointer-events-none absolute left-3 text-gray-500 flex items-center">
              {leftAddon}
            </div>
          )}

          <input
            ref={ref}
            id={inputId}
            className={cn(
              'w-full rounded-xl bg-white/[0.04] border text-sm text-gray-200 placeholder:text-gray-600',
              'transition-all duration-150 outline-none',
              'focus:bg-white/[0.06] focus:border-indigo-500/50 focus:ring-2 focus:ring-indigo-500/20',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              error
                ? 'border-red-500/40 focus:border-red-500/60 focus:ring-red-500/20'
                : 'border-white/[0.08]',
              leftAddon ? 'pl-9' : 'pl-4',
              rightAddon ? 'pr-9' : 'pr-4',
              'py-2.5',
              className,
            )}
            {...props}
          />

          {rightAddon && (
            <div className="absolute right-3 text-gray-500 flex items-center">{rightAddon}</div>
          )}
        </div>

        {error && <p className="text-xs text-red-400 flex items-center gap-1">{error}</p>}

        {!error && hint && <p className="text-xs text-gray-600">{hint}</p>}
      </div>
    );
  },
);

Input.displayName = 'Input';
