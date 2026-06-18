import http from 'http';

import { createApp } from './app';
import { config } from './config';
import { connectDatabase, disconnectDatabase } from './lib/prisma';
import { createSocketServer } from './lib/socket';
import { logger } from './utils/logger';

const PORT = config.server.port;

async function bootstrap(): Promise<void> {
  // Connect to external services
  await connectDatabase();

  // Create Express app
  const app = createApp();

  // Create HTTP server (wrapping Express)
  const httpServer = http.createServer(app);

  // Attach Socket.IO to HTTP server
  createSocketServer(httpServer);

  // Start listening
  httpServer.listen(PORT, () => {
    logger.info(`Server started`, {
      port: PORT,
      env: config.server.env,
      url: `http://localhost:${PORT}`,
    });
  });

  // ============================================================
  // Graceful Shutdown
  // ============================================================

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);

    // Stop accepting new connections
    httpServer.close(async (err) => {
      if (err) {
        logger.error('Error closing HTTP server', { error: String(err) });
        process.exit(1);
      }

      try {
        await disconnectDatabase();
        logger.info('Graceful shutdown complete');
        process.exit(0);
      } catch (shutdownErr) {
        logger.error('Error during shutdown', { error: String(shutdownErr) });
        process.exit(1);
      }
    });

    // Force exit after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught exception', {
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection', {
      reason: String(reason),
    });
    process.exit(1);
  });
}

// Start the server
bootstrap().catch((err) => {
  logger.error('Failed to start server', { error: String(err) });
  process.exit(1);
});
