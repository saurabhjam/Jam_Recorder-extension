import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../utils/cn';

// ─── Types ────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'link';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  as?: 'button' | 'a';
}

// ─── Style maps ───────────────────────────────────────────────────────────────

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow-sm shadow-indigo-500/20 hover:from-indigo-500 hover:to-blue-500 focus-visible:ring-indigo-500/50',
  secondary:
    'bg-white/[0.06] text-gray-200 border border-white/[0.10] hover:bg-white/[0.10] hover:border-white/[0.18] focus-visible:ring-white/20',
  ghost: 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] focus-visible:ring-white/20',
  danger:
    'bg-red-600 text-white hover:bg-red-500 shadow-sm shadow-red-500/20 focus-visible:ring-red-500/50',
  outline:
    'border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10 hover:border-indigo-500/60 focus-visible:ring-indigo-500/50',
  link: 'text-indigo-400 hover:text-indigo-300 underline-offset-4 hover:underline focus-visible:ring-indigo-500/50 p-0 h-auto',
};

const sizeStyles: Record<ButtonSize, string> = {
  xs: 'h-6  px-2   text-[11px] gap-1   rounded-md',
  sm: 'h-8  px-3   text-xs     gap-1.5 rounded-lg',
  md: 'h-9  px-4   text-sm     gap-2   rounded-xl',
  lg: 'h-11 px-5   text-sm     gap-2   rounded-xl',
  xl: 'h-13 px-6   text-base   gap-2.5 rounded-2xl',
};

// ─── Spinner ──────────────────────────────────────────────────────────────────

function ButtonSpinner({ size }: { size: ButtonSize }) {
  const spinnerSize = {
    xs: 'h-3 w-3',
    sm: 'h-3.5 w-3.5',
    md: 'h-4 w-4',
    lg: 'h-4 w-4',
    xl: 'h-5 w-5',
  }[size];
  return (
    <svg
      className={cn('animate-spin', spinnerSize)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      leftIcon,
      rightIcon,
      children,
      className,
      disabled,
      ...props
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;

    return (
      <motion.button
        ref={ref}
        whileTap={isDisabled ? undefined : { scale: 0.97 }}
        disabled={isDisabled}
        className={cn(
          // Base
          'inline-flex items-center justify-center font-medium transition-all duration-150',
          'focus-visible:outline-none focus-visible:ring-2',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          // Link variant is special
          variant !== 'link' && sizeStyles[size],
          variantStyles[variant],
          className,
        )}
        {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {loading ? (
          <>
            <ButtonSpinner size={size} />
            {children && <span className="opacity-70">{children}</span>}
          </>
        ) : (
          <>
            {leftIcon}
            {children}
            {rightIcon}
          </>
        )}
      </motion.button>
    );
  },
);

Button.displayName = 'Button';
