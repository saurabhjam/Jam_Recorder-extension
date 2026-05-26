import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Application, type Request, type Response } from 'express';
import helmet from 'helmet';
import { passport } from './lib/passport';

import { config } from './config';
import { httpLogger } from './utils/logger';
import { apiRateLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { getQueueHealth } from './queues';

// Route imports
import authRoutes from './routes/auth';
import recordingsRoutes from './routes/recordings';
import uploadsRoutes from './routes/uploads';
import sharesRoutes from './routes/shares';
import teamsRoutes from './routes/teams';
import commentsRoutes from './routes/comments';
import reactionsRoutes from './routes/reactions';

const API_PREFIX = '/api';

export function createApp(): Application {
  const app = express();

  // ============================================================
  // Security Middleware
  // ============================================================

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: config.server.isProd ? undefined : false,
    }),
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
          return callback(null, true);
        }

        if (config.cors.origins.includes(origin) || config.server.isDev) {
          callback(null, true);
        } else {
          callback(new Error(`CORS: Origin ${origin} not allowed`));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      exposedHeaders: ['X-Request-ID', 'RateLimit-Remaining', 'RateLimit-Reset'],
    }),
  );

  // ============================================================
  // Passport (OAuth)
  // ============================================================

  app.use(passport.initialize());

  // ============================================================
  // General Middleware
  // ============================================================

  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // BigInt serialization — Prisma returns BigInt for size fields; JSON.stringify
  // crashes without this. Converts BigInt to string so clients receive a number-string.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  app.use(httpLogger);

  // Trust proxy (for rate limiting with real IPs behind load balancers)
  if (config.server.isProd) {
    app.set('trust proxy', 1);
  }

  // ============================================================
  // Health Check (before rate limiting)
  // ============================================================

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const queueHealth = await getQueueHealth().catch(() => ({}));
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: process.env['npm_package_version'] ?? '1.0.0',
        environment: config.server.env,
        queues: queueHealth,
      });
    } catch {
      res.status(503).json({ status: 'error', timestamp: new Date().toISOString() });
    }
  });

  // ============================================================
  // Rate Limiting
  // ============================================================

  app.use(API_PREFIX, apiRateLimiter);

  // ============================================================
  // API Routes
  // ============================================================

  app.use(`${API_PREFIX}/auth`, authRoutes);
  app.use(`${API_PREFIX}/recordings`, recordingsRoutes);
  app.use(`${API_PREFIX}/recordings/:id/comments`, commentsRoutes);
  app.use(`${API_PREFIX}/recordings/:id/reactions`, reactionsRoutes);
  app.use(`${API_PREFIX}/uploads`, uploadsRoutes);
  app.use(`${API_PREFIX}/shares`, sharesRoutes);
  app.use(`${API_PREFIX}/teams`, teamsRoutes);

  // ============================================================
  // 404 & Error Handlers
  // ============================================================

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
