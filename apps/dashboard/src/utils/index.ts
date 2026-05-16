import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow, format } from 'date-fns';

/** Merge Tailwind classes safely */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/** Format seconds to mm:ss or hh:mm:ss */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format date to relative string */
export function formatRelativeDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatDistanceToNow(d, { addSuffix: true });
}

/** Format date to readable string */
export function formatDate(date: Date | string, fmt = 'MMM d, yyyy'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(d, fmt);
}

/** Truncate string */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}…`;
}

/** Generate a random ID */
export function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** Copy text to clipboard */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    return true;
  }
}

/** Debounce function */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/** Get initials from name */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Format number with commas */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** Format percentage */
export function formatPercent(value: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

/** Sleep utility */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if a value is defined */
export function isDefined<T>(val: T | undefined | null): val is T {
  return val !== undefined && val !== null;
}

/** Clamp a number between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Get recording type color */
export function getRecordingTypeColor(type: string): string {
  const map: Record<string, string> = {
    SCREEN: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
    TAB: 'text-green-400 bg-green-400/10 border-green-400/20',
    WEBCAM: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
    SCREENSHOT: 'text-pink-400 bg-pink-400/10 border-pink-400/20',
  };
  return map[type] ?? 'text-gray-400 bg-gray-400/10 border-gray-400/20';
}

/** Get recording status color */
export function getRecordingStatusColor(status: string): string {
  const map: Record<string, string> = {
    READY: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    PROCESSING: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
    UPLOADING: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
    FAILED: 'text-red-400 bg-red-400/10 border-red-400/20',
  };
  return map[status] ?? 'text-gray-400 bg-gray-400/10 border-gray-400/20';
}

/** Build share URL */
export function buildShareUrl(shareId: string): string {
  return `${window.location.origin}/share/${shareId}`;
}
