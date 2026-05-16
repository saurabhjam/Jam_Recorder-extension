import { PrismaClient } from '@prisma/client';

import { config } from '../config';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.server.isDev ? ['query', 'error', 'warn'] : ['error'],
    errorFormat: config.server.isDev ? 'pretty' : 'minimal',
  });

if (config.server.isDev) {
  globalForPrisma.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.info('[Database] Connected to PostgreSQL via Prisma');
  } catch (error) {
    console.error('[Database] Failed to connect:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.info('[Database] Disconnected from PostgreSQL');
}

export default prisma;
