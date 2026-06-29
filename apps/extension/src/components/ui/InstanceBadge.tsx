import { motion } from 'framer-motion';
import { ShieldCheck, FlaskConical } from 'lucide-react';
import { INSTANCE_LABEL, IS_PRODUCTION } from '@/config';

interface InstanceBadgeProps {
  /** Icon size in px. */
  size?: number;
  className?: string;
}

/**
 * Small animated icon badge that marks the build instance so the two versions
 * are never confused: a green shield for Production, a yellow flask for QA.
 * Springs in on mount and keeps a soft breathing glow. Renders nothing when no
 * instance is configured (e.g. local dev builds).
 */
export function InstanceBadge({ size = 15, className = '' }: InstanceBadgeProps) {
  if (!INSTANCE_LABEL) return null;

  const Icon = IS_PRODUCTION ? ShieldCheck : FlaskConical;
  const glow = IS_PRODUCTION ? 'rgba(16,185,129,0.55)' : 'rgba(245,158,11,0.55)';

  return (
    <motion.span
      title={INSTANCE_LABEL}
      initial={{ scale: 0, rotate: -25, opacity: 0 }}
      animate={{
        scale: 1,
        rotate: 0,
        opacity: 1,
        boxShadow: [`0 0 0px 0px ${glow}`, `0 0 10px 1px ${glow}`, `0 0 0px 0px ${glow}`],
      }}
      transition={{
        scale: { type: 'spring', stiffness: 400, damping: 16 },
        rotate: { type: 'spring', stiffness: 400, damping: 16 },
        opacity: { duration: 0.2 },
        boxShadow: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
      }}
      whileHover={{ scale: 1.12, rotate: 6 }}
      className={`inline-flex items-center justify-center rounded-lg border shrink-0 ${
        IS_PRODUCTION
          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
          : 'bg-amber-500/15 text-amber-400 border-amber-500/40'
      } ${className}`}
      style={{ width: size + 9, height: size + 9 }}
    >
      <Icon size={size} strokeWidth={2.2} />
    </motion.span>
  );
}
