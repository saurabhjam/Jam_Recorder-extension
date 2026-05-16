import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../utils/cn';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CardProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  hoverable?: boolean;
  className?: string;
  onClick?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Card({
  children,
  header,
  footer,
  hoverable = false,
  className,
  onClick,
}: CardProps) {
  const base = cn(
    'rounded-2xl bg-gray-900/80 border border-white/[0.06] shadow-sm overflow-hidden',
    hoverable &&
      'transition-all duration-200 hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/20 cursor-pointer',
    className,
  );

  const content = (
    <>
      {header && <div className="px-5 py-4 border-b border-white/[0.06]">{header}</div>}
      <div className="p-5">{children}</div>
      {footer && (
        <div className="px-5 py-4 border-t border-white/[0.06] bg-white/[0.02]">{footer}</div>
      )}
    </>
  );

  if (hoverable) {
    return (
      <motion.div
        whileHover={{ y: -2 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
        className={base}
        onClick={onClick}
      >
        {content}
      </motion.div>
    );
  }

  return (
    <div className={base} onClick={onClick}>
      {content}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

export function CardHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mb-4', className)}>{children}</div>;
}

export function CardTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <h3 className={cn('text-base font-semibold text-gray-100', className)}>{children}</h3>;
}

export function CardDescription({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={cn('text-sm text-gray-500 mt-0.5', className)}>{children}</p>;
}
