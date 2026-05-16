import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/utils';

interface RecordingTypeCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  selected?: boolean;
  onClick: () => void;
  badge?: string;
  disabled?: boolean;
}

export function RecordingTypeCard({
  icon,
  title,
  description,
  selected = false,
  onClick,
  badge,
  disabled = false,
}: RecordingTypeCardProps) {
  return (
    <motion.button
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? {} : { y: -2, scale: 1.01 }}
      whileTap={disabled ? {} : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className={cn(
        'relative flex flex-col items-center gap-2.5 p-4 rounded-2xl',
        'border transition-all duration-200 cursor-pointer text-left',
        'focus:outline-none group overflow-hidden',
        selected
          ? ['bg-jam-500/15 border-jam-500/60', 'shadow-jam'].join(' ')
          : [
              'bg-dark-800/60 border-white/8',
              'hover:bg-dark-800/90 hover:border-jam-500/30',
              'hover:shadow-glass',
            ].join(' '),
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
      )}
    >
      {/* Glow effect on selected */}
      {selected && (
        <motion.div
          className="absolute inset-0 bg-jam-500/10 rounded-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          layoutId="card-glow"
        />
      )}

      {/* Background shimmer on hover */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-jam-500/5 to-violet-500/5" />
      </div>

      {/* Icon */}
      <motion.div
        className={cn(
          'relative z-10 w-11 h-11 rounded-xl flex items-center justify-center',
          'transition-all duration-200',
          selected
            ? 'bg-jam-500/25 text-jam-300'
            : 'bg-dark-700/80 text-dark-300 group-hover:bg-jam-500/15 group-hover:text-jam-400',
        )}
        animate={selected ? { scale: [1, 1.1, 1] } : {}}
        transition={{ duration: 0.3 }}
      >
        {icon}
      </motion.div>

      {/* Text */}
      <div className="relative z-10 text-center">
        <p
          className={cn(
            'text-xs font-semibold leading-tight',
            selected ? 'text-jam-300' : 'text-white group-hover:text-jam-200',
          )}
        >
          {title}
        </p>
        <p className="text-xxs text-dark-400 mt-0.5 group-hover:text-dark-300 transition-colors">
          {description}
        </p>
      </div>

      {/* Badge */}
      {badge && (
        <span className="absolute top-2 right-2 text-xxs font-bold px-1.5 py-0.5 rounded-md bg-jam-500/30 text-jam-300 border border-jam-500/20">
          {badge}
        </span>
      )}

      {/* Selection indicator */}
      {selected && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="absolute top-2 left-2 w-4 h-4 rounded-full bg-jam-500 flex items-center justify-center"
        >
          <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="text-white">
            <path
              d="M1 3L3 5L7 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.div>
      )}
    </motion.button>
  );
}
