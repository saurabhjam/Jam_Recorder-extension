import React from 'react';
import { cn } from '@utils/index';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftAddon?: React.ReactNode;
  rightAddon?: React.ReactNode;
  wrapperClassName?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    { label, error, hint, leftAddon, rightAddon, wrapperClassName, className, id, ...rest },
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
            <div className="absolute left-3 flex items-center text-gray-500 pointer-events-none z-10">
              {leftAddon}
            </div>
          )}

          <input
            ref={ref}
            id={inputId}
            className={cn(
              'input-base',
              leftAddon && 'pl-10',
              rightAddon && 'pr-10',
              error && 'border-red-500/50 focus:ring-red-500/50 focus:border-red-500/50',
              className,
            )}
            {...rest}
          />

          {rightAddon && (
            <div className="absolute right-3 flex items-center text-gray-500 z-10">
              {rightAddon}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
    );
  },
);

Input.displayName = 'Input';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
  wrapperClassName?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, wrapperClassName, className, id, ...rest }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-gray-300">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={cn(
            'input-base resize-none min-h-[80px]',
            error && 'border-red-500/50 focus:ring-red-500/50',
            className,
          )}
          {...rest}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
    );
  },
);

Textarea.displayName = 'Textarea';
