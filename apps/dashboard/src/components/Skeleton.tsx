import { cn } from '@utils/index';

function SkeletonBase({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-md bg-white/[0.04] shimmer relative overflow-hidden', className)} />
  );
}

export function SkeletonText({ lines = 1, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBase
          key={i}
          className={cn('h-4', i === lines - 1 && lines > 1 ? 'w-3/4' : 'w-full')}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('card p-5 space-y-4', className)}>
      <div className="flex items-center gap-3">
        <SkeletonBase className="h-10 w-10 rounded-lg flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <SkeletonBase className="h-4 w-1/2" />
          <SkeletonBase className="h-3 w-1/3" />
        </div>
      </div>
      <SkeletonText lines={3} />
    </div>
  );
}

export function SkeletonRecordingCard({ className }: { className?: string }) {
  return (
    <div className={cn('card overflow-hidden', className)}>
      <SkeletonBase className="h-40 w-full rounded-none" />
      <div className="p-4 space-y-3">
        <SkeletonBase className="h-4 w-3/4" />
        <div className="flex gap-2">
          <SkeletonBase className="h-5 w-16 rounded-full" />
          <SkeletonBase className="h-5 w-12 rounded-full" />
        </div>
        <div className="flex justify-between">
          <SkeletonBase className="h-3 w-20" />
          <SkeletonBase className="h-3 w-16" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonTable({
  rows = 5,
  cols = 4,
  className,
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3', className)}>
      {/* Header */}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonBase key={i} className="h-4" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBase key={c} className="h-8 rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonStats({ className }: { className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 md:grid-cols-4 gap-4', className)}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="card p-5 space-y-3">
          <div className="flex justify-between">
            <SkeletonBase className="h-4 w-24" />
            <SkeletonBase className="h-8 w-8 rounded-lg" />
          </div>
          <SkeletonBase className="h-8 w-20" />
          <SkeletonBase className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
