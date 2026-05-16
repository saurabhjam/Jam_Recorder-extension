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
  className?: string;
}

export function StatsCard({
  label,
  value,
  change,
  changeLabel,
  icon,
  iconColor = 'text-violet-400 bg-violet-400/10',
  className,
}: StatsCardProps) {
  const isPositive = change !== undefined && change > 0;
  const isNegative = change !== undefined && change < 0;
  const isNeutral = change === undefined || change === 0;

  return (
    <div className={cn('stat-card card-hover', className)}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 font-medium">{label}</p>
        </div>
        <div className={cn('p-2.5 rounded-xl text-sm', iconColor)}>{icon}</div>
      </div>

      <div>
        <p className="text-2xl font-bold text-gray-100 tracking-tight">{value}</p>
      </div>

      {change !== undefined && (
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'flex items-center gap-0.5 text-xs font-medium',
              isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-gray-500',
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
          {changeLabel && <span className="text-xs text-gray-600">{changeLabel}</span>}
        </div>
      )}
    </div>
  );
}
