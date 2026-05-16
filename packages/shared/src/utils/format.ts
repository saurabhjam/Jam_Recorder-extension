/**
 * Format a byte count into a human-readable string.
 * @example formatBytes(1536) => "1.5 KB"
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return '—';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = parseFloat((bytes / Math.pow(k, i)).toFixed(Math.max(0, decimals)));
  return `${value} ${sizes[i]}`;
}

/**
 * Format a duration in seconds to HH:MM:SS or MM:SS.
 * @example formatDuration(3723) => "1:02:03"
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const totalSeconds = Math.floor(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');

  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Format a date to a relative time string.
 * @example formatRelativeTime(new Date(Date.now() - 7200_000)) => "2 hours ago"
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  const diffWk = Math.floor(diffDay / 7);
  if (diffWk < 5) return `${diffWk}w ago`;

  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;

  const diffYr = Math.floor(diffDay / 365);
  return `${diffYr}y ago`;
}

/**
 * Format a date to a readable string.
 * @example formatDate(new Date(), 'short') => "Jan 1, 2025"
 */
export function formatDate(
  date: Date | string,
  format: 'short' | 'long' | 'numeric' = 'short',
): string {
  const d = typeof date === 'string' ? new Date(date) : date;

  if (isNaN(d.getTime())) return '—';

  const opts: Intl.DateTimeFormatOptions = (() => {
    switch (format) {
      case 'long':
        return { year: 'numeric', month: 'long', day: 'numeric' };
      case 'numeric':
        return { year: 'numeric', month: '2-digit', day: '2-digit' };
      default:
        return { year: 'numeric', month: 'short', day: 'numeric' };
    }
  })();

  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

/**
 * Truncate a string to a maximum length, appending an ellipsis.
 * @example truncate("Hello World", 7) => "Hello W…"
 */
export function truncate(str: string, length: number): string {
  if (!str) return '';
  if (str.length <= length) return str;
  return `${str.slice(0, length)}…`;
}

/**
 * Capitalize the first letter of a string.
 * @example capitalize("hello") => "Hello"
 */
export function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert a string to a URL-safe slug.
 * @example slugify("Hello World!") => "hello-world"
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
