import { motion } from 'framer-motion';
import { cn } from '@/utils';

interface ProgressBarProps {
  value: number; // 0-100
  label?: string;
  showPercentage?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'success' | 'danger';
  animated?: boolean;
  className?: string;
}

const sizeStyles = {
  sm: 'h-1.5',
  md: 'h-2.5',
  lg: 'h-4',
};

const variantStyles = {
  default: 'from-jam-500 via-violet-500 to-jam-400',
  success: 'from-green-500 to-emerald-400',
  danger: 'from-red-500 to-orange-500',
};

export function ProgressBar({
  value,
  label,
  showPercentage = true,
  size = 'md',
  variant = 'default',
  animated = true,
  className,
}: ProgressBarProps) {
  const clampedValue = Math.min(100, Math.max(0, value));

  return (
    <div className={cn('w-full', className)}>
      {(label || showPercentage) && (
        <div className="flex items-center justify-between mb-2">
          {label && <span className="text-xs font-medium text-dark-300">{label}</span>}
          {showPercentage && (
            <span className="text-xs font-semibold text-white">{Math.round(clampedValue)}%</span>
          )}
        </div>
      )}

      <div
        className={cn(
          'relative w-full rounded-full overflow-hidden',
          'bg-dark-700/80 border border-white/5',
          sizeStyles[size],
        )}
      >
        {/* Track glow */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/3 to-transparent" />

        {/* Fill */}
        <motion.div
          className={cn(
            'h-full rounded-full bg-gradient-to-r',
            variantStyles[variant],
            animated && 'progress-bar-fill',
          )}
          initial={{ width: 0 }}
          animate={{ width: `${clampedValue}%` }}
          transition={{ type: 'spring', stiffness: 60, damping: 12 }}
          style={{ backgroundSize: '200% 100%' }}
        >
          {/* Inner highlight */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/20 to-transparent" />
        </motion.div>

        {/* Glow dot at progress tip */}
        {clampedValue > 2 && clampedValue < 99 && (
          <motion.div
            className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white shadow-lg"
            animate={{ left: `calc(${clampedValue}% - 4px)` }}
            transition={{ type: 'spring', stiffness: 60, damping: 12 }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Segmented Progress ───────────────────────────────────────────────────────

interface SegmentedProgressProps {
  total: number;
  completed: number;
  current?: number; // currently uploading chunk
  className?: string;
}

export function SegmentedProgress({
  total,
  completed,
  current,
  className,
}: SegmentedProgressProps) {
  if (total === 0) return null;

  return (
    <div className={cn('flex gap-0.5', className)}>
      {Array.from({ length: total }, (_, i) => {
        const isCompleted = i < completed;
        const isCurrent = i === completed && current !== undefined;

        return (
          <motion.div
            key={i}
            className={cn(
              'flex-1 h-1.5 rounded-full transition-all duration-300',
              isCompleted ? 'bg-jam-500' : isCurrent ? 'bg-jam-500/50 shimmer' : 'bg-dark-700',
            )}
            initial={isCompleted ? { scaleX: 0, originX: 0 } : {}}
            animate={isCompleted ? { scaleX: 1 } : {}}
            transition={{ delay: i * 0.02 }}
          />
        );
      })}
    </div>
  );
}
