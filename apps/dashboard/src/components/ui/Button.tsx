import React from 'react';
import { cn } from '@utils/index';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'link';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children?: React.ReactNode;
}

const variantStyles: Record<Variant, string> = {
  primary:
    'bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white shadow-sm shadow-indigo-500/20 border border-indigo-500/30 font-medium',
  secondary:
    'bg-white/[0.06] hover:bg-white/[0.10] text-gray-200 border border-white/[0.08] hover:border-white/[0.15] font-medium',
  ghost:
    'bg-transparent hover:bg-white/[0.06] text-gray-400 hover:text-gray-100 border border-transparent font-medium',
  danger: 'bg-red-600/80 hover:bg-red-600 text-white border border-red-500/30 font-medium',
  outline:
    'bg-transparent hover:bg-violet-600/10 text-violet-400 hover:text-violet-300 border border-violet-500/40 hover:border-violet-400/60 font-medium',
  link: 'bg-transparent text-violet-400 hover:text-violet-300 underline-offset-4 hover:underline border-transparent p-0 h-auto',
};

const sizeStyles: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs rounded',
  sm: 'h-8 px-3 text-sm rounded-md',
  md: 'h-9 px-4 text-sm rounded-lg',
  lg: 'h-11 px-6 text-base rounded-lg',
  icon: 'h-9 w-9 rounded-lg p-0',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading,
      leftIcon,
      rightIcon,
      children,
      className,
      disabled,
      ...rest
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={cn(
          'inline-flex items-center justify-center gap-2 transition-all duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
          'select-none whitespace-nowrap',
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        {...rest}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : leftIcon ? (
          <span className="flex-shrink-0">{leftIcon}</span>
        ) : null}
        {children}
        {rightIcon && !loading && <span className="flex-shrink-0">{rightIcon}</span>}
      </button>
    );
  },
);

Button.displayName = 'Button';
