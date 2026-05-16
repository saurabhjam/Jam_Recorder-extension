import morgan, { type StreamOptions } from 'morgan';

import { config } from '../config';

// ============================================================
// Custom Logging Utilities
// ============================================================

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

function formatLog(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };

  if (config.server.isProd) {
    return JSON.stringify(entry);
  }

  const color = {
    info: '\x1b[36m', // Cyan
    warn: '\x1b[33m', // Yellow
    error: '\x1b[31m', // Red
    debug: '\x1b[35m', // Magenta
  }[level];

  const reset = '\x1b[0m';
  const timestamp = `\x1b[90m${entry.timestamp}\x1b[0m`;
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';

  return `${timestamp} ${color}[${level.toUpperCase()}]${reset} ${message}${metaStr}`;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.info(formatLog('info', message, meta));
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(formatLog('warn', message, meta));
  },

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(formatLog('error', message, meta));
  },

  debug(message: string, meta?: Record<string, unknown>): void {
    if (config.server.isDev) {
      console.info(formatLog('debug', message, meta));
    }
  },
};

// ============================================================
// Morgan HTTP Request Logger
// ============================================================

const morganStream: StreamOptions = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};

// Development format: colored, human-readable
const devFormat = ':method :url :status :response-time ms - :res[content-length]';

// Production format: JSON structured
const prodFormat = JSON.stringify({
  method: ':method',
  url: ':url',
  status: ':status',
  responseTime: ':response-time',
  contentLength: ':res[content-length]',
  userAgent: ':user-agent',
  ip: ':remote-addr',
});

export const httpLogger = morgan(config.server.isProd ? prodFormat : devFormat, {
  stream: morganStream,
  skip: (req) => {
    // Skip health checks in production to reduce noise
    return config.server.isProd && req.url === '/health';
  },
});

export default logger;
