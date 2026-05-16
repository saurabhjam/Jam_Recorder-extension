import winston from 'winston';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const isProd = process.env.NODE_ENV === 'production';

const devFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const errorStr = stack ? `\n${stack}` : '';
  return `${ts} [${level}] ${message}${metaStr}${errorStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    isProd ? json() : combine(colorize({ all: true }), devFormat),
  ),
  transports: [
    new winston.transports.Console(),
    // In production, add file transports
    ...(isProd
      ? [
          new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: 10_000_000,
            maxFiles: 5,
          }),
          new winston.transports.File({
            filename: 'logs/combined.log',
            maxsize: 10_000_000,
            maxFiles: 10,
          }),
        ]
      : []),
  ],
  exitOnError: false,
});

/** Create a child logger with additional context */
export function createChildLogger(context: Record<string, unknown>): winston.Logger {
  return logger.child(context);
}
