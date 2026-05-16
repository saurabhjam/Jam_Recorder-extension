import { useState } from 'react';
import { cn, getInitials } from '@/utils';

interface AvatarProps {
  src?: string;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizeStyles = {
  xs: 'w-6 h-6 text-xxs',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-16 h-16 text-xl',
};

const GRADIENT_CLASSES = [
  'from-jam-500 to-violet-500',
  'from-blue-500 to-cyan-500',
  'from-green-500 to-emerald-500',
  'from-amber-500 to-orange-500',
  'from-pink-500 to-rose-500',
];

function getGradientForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GRADIENT_CLASSES[Math.abs(hash) % GRADIENT_CLASSES.length];
}

export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const showImage = src && !imgError;
  const initials = name ? getInitials(name) : '?';
  const gradient = name ? getGradientForName(name) : GRADIENT_CLASSES[0];

  return (
    <div
      className={cn(
        'rounded-full overflow-hidden shrink-0',
        'flex items-center justify-center',
        sizeStyles[size],
        !showImage && `bg-gradient-to-br ${gradient}`,
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt={name ?? 'Avatar'}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <span className="font-semibold text-white leading-none">{initials}</span>
      )}
    </div>
  );
}
