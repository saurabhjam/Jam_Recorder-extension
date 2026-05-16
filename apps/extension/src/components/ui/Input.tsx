import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    { label, error, helperText, leftIcon, rightIcon, fullWidth = true, className, id, ...rest },
    ref,
  ) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className={cn('flex flex-col gap-1.5', fullWidth && 'w-full')}>
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-medium text-dark-300 tracking-wide uppercase"
          >
            {label}
          </label>
        )}

        <div className="relative">
          {leftIcon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-400 pointer-events-none">
              {leftIcon}
            </div>
          )}

          <input
            ref={ref}
            id={inputId}
            className={cn(
              'w-full h-10 rounded-xl text-sm transition-all duration-200',
              'bg-dark-900/80 text-white placeholder:text-dark-400',
              'border outline-none',
              error
                ? 'border-red-500/60 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
                : 'border-jam-500/20 focus:border-jam-500/60 focus:ring-2 focus:ring-jam-500/15',
              leftIcon ? 'pl-10' : 'pl-3.5',
              rightIcon ? 'pr-10' : 'pr-3.5',
              className,
            )}
            {...rest}
          />

          {rightIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-400">
              {rightIcon}
            </div>
          )}
        </div>

        {error && (
          <p className="text-xs text-red-400 flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-red-400 shrink-0" />
            {error}
          </p>
        )}

        {helperText && !error && <p className="text-xs text-dark-400">{helperText}</p>}
      </div>
    );
  },
);

Input.displayName = 'Input';
