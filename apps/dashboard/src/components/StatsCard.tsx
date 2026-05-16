import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@utils/index';

interface StatsCardProps {
  label: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  icon: React.ReactNode;
  iconColor?: string;
  accentColor?: string;
  className?: string;
}

export function StatsCard({
  label,
  value,
  change,
  changeLabel,
  icon,
  iconColor = 'text-violet-400',
  accentColor = 'rgba(139,92,246,0.15)',
  className,
}: StatsCardProps) {
  const isPositive = change !== undefined && change > 0;
  const isNegative = change !== undefined && change < 0;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl p-5 flex flex-col gap-4 transition-all duration-200 hover:-translate-y-0.5',
        className,
      )}
      style={{
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.018) 100%)',
        border: '1px solid rgba(255,255,255,0.07)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
      }}
    >
      {/* Subtle corner glow */}
      <div
        className="absolute -top-8 -right-8 w-24 h-24 rounded-full pointer-events-none"
        style={{ background: accentColor, filter: 'blur(20px)', opacity: 0.6 }}
      />

      {/* Top row: label + icon */}
      <div className="flex items-start justify-between relative">
        <p className="text-sm text-slate-400 font-medium">{label}</p>
        <div
          className={cn('p-2.5 rounded-xl flex-shrink-0', iconColor)}
          style={{ background: accentColor }}
        >
          {icon}
        </div>
      </div>

      {/* Value */}
      <div className="relative">
        <p className="text-3xl font-bold text-slate-50 tracking-tight tabular-nums">{value}</p>
      </div>

      {/* Trend */}
      {change !== undefined && (
        <div className="flex items-center gap-1.5 relative">
          <span
            className={cn(
              'flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded-full',
              isPositive
                ? 'text-emerald-400 bg-emerald-400/10'
                : isNegative
                  ? 'text-red-400 bg-red-400/10'
                  : 'text-slate-500 bg-white/[0.05]',
            )}
          >
            {isPositive ? (
              <TrendingUp className="h-3 w-3" />
            ) : isNegative ? (
              <TrendingDown className="h-3 w-3" />
            ) : (
              <Minus className="h-3 w-3" />
            )}
            {isPositive ? '+' : ''}
            {change}%
          </span>
          {changeLabel && <span className="text-xs text-slate-600">{changeLabel}</span>}
        </div>
      )}
    </div>
  );
}
