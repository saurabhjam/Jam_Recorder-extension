import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const prisma = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  if (process.env.NODE_ENV !== 'production') {
    // Log slow queries in development
    prisma.$on('query' as never, (e: { duration: number; query: string }) => {
      if (e.duration > 200) {
        logger.warn('Slow query detected', {
          duration: `${e.duration}ms`,
          query: e.query.slice(0, 100),
        });
      }
    });
  }

  prisma.$on('error' as never, (e: { message: string }) => {
    logger.error('Prisma error', { message: e.message });
  });

  return prisma;
}

// Singleton pattern to avoid too many connections in development
export const prisma: PrismaClient = global.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

/** Gracefully disconnect Prisma */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Prisma disconnected');
}
