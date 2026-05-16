import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'success';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    'bg-gradient-to-r from-jam-500 to-violet-500',
    'hover:from-jam-600 hover:to-violet-600',
    'text-white font-semibold',
    'shadow-jam hover:shadow-jam-lg',
    'border-transparent',
  ].join(' '),

  secondary: [
    'bg-dark-800 hover:bg-dark-700',
    'text-white font-medium',
    'border border-white/10 hover:border-white/20',
  ].join(' '),

  ghost: [
    'bg-transparent hover:bg-white/8',
    'text-dark-300 hover:text-white',
    'border-transparent',
  ].join(' '),

  danger: [
    'bg-gradient-to-r from-red-500 to-red-600',
    'hover:from-red-600 hover:to-red-700',
    'text-white font-semibold',
    'shadow-recording hover:shadow-lg',
    'border-transparent',
  ].join(' '),

  outline: [
    'bg-transparent',
    'border border-jam-500/40 hover:border-jam-500/80',
    'text-jam-400 hover:text-jam-300',
    'hover:bg-jam-500/10',
  ].join(' '),

  success: [
    'bg-gradient-to-r from-green-500 to-emerald-500',
    'hover:from-green-600 hover:to-emerald-600',
    'text-white font-semibold',
    'border-transparent',
  ].join(' '),
};

const sizeStyles: Record<ButtonSize, string> = {
  xs: 'h-7 px-2.5 text-xs rounded-lg gap-1',
  sm: 'h-8 px-3 text-sm rounded-xl gap-1.5',
  md: 'h-10 px-4 text-sm rounded-xl gap-2',
  lg: 'h-12 px-6 text-base rounded-2xl gap-2.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      leftIcon,
      rightIcon,
      fullWidth = false,
      disabled,
      children,
      className,
      ...rest
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;

    return (
      <motion.button
        ref={ref}
        whileTap={isDisabled ? {} : { scale: 0.96 }}
        whileHover={isDisabled ? {} : { y: -1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
        className={cn(
          'inline-flex items-center justify-center',
          'border transition-all duration-200',
          'select-none outline-none focus-visible:ring-2 focus-visible:ring-jam-500/60',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
          variantStyles[variant],
          sizeStyles[size],
          fullWidth && 'w-full',
          className,
        )}
        disabled={isDisabled}
        {...(rest as React.ComponentProps<typeof motion.button>)}
      >
        {loading ? (
          <Loader2 className="animate-spin shrink-0" size={size === 'lg' ? 18 : 14} />
        ) : leftIcon ? (
          <span className="shrink-0">{leftIcon}</span>
        ) : null}

        {children && <span className="truncate">{children}</span>}

        {!loading && rightIcon && <span className="shrink-0">{rightIcon}</span>}
      </motion.button>
    );
  },
);

Button.displayName = 'Button';
