import type { Server as HTTPServer } from 'http';

import jwt from 'jsonwebtoken';
import { Server, type Socket } from 'socket.io';

import { config } from '../config';
import { prisma } from './prisma';

interface JwtPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

interface AuthenticatedSocket extends Socket {
  userId?: string;
  email?: string;
}

let io: Server | null = null;

export function createSocketServer(httpServer: HTTPServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: config.cors.origins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // JWT Authentication middleware for sockets
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;

      // Verify user still exists and is active
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId, isActive: true },
        select: { id: true, email: true },
      });

      if (!user) {
        return next(new Error('User not found or inactive'));
      }

      socket.userId = user.id;
      socket.email = user.email;
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return next(new Error('Token expired'));
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return next(new Error('Invalid token'));
      }
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.userId;
    console.info(`[Socket] User ${userId} connected (${socket.id})`);

    // Auto-join user's personal room
    if (userId) {
      void socket.join(`user:${userId}`);
    }

    // Handle room joining (e.g., for watching a recording)
    socket.on('room:join', (roomId: string) => {
      void socket.join(roomId);
      console.info(`[Socket] User ${userId} joined room ${roomId}`);
    });

    socket.on('room:leave', (roomId: string) => {
      void socket.leave(roomId);
      console.info(`[Socket] User ${userId} left room ${roomId}`);
    });

    socket.on('disconnect', (reason) => {
      console.info(`[Socket] User ${userId} disconnected: ${reason}`);
    });

    socket.on('error', (error: Error) => {
      console.error(`[Socket] Error for user ${userId}:`, error.message);
    });
  });

  console.info('[Socket.IO] Server initialized');
  return io;
}

export function getSocketServer(): Server {
  if (!io) {
    throw new Error('Socket.IO server not initialized. Call createSocketServer first.');
  }
  return io;
}

// Emit helpers
export function emitToUser(userId: string, event: string, data: unknown): void {
  const server = getSocketServer();
  server.to(`user:${userId}`).emit(event, data);
}

export function emitToRoom(roomId: string, event: string, data: unknown): void {
  const server = getSocketServer();
  server.to(roomId).emit(event, data);
}

export function broadcastRecordingReady(recordingId: string, userId: string): void {
  emitToUser(userId, 'recording:ready', { recordingId });
  emitToRoom(`recording:${recordingId}`, 'recording:ready', { recordingId });
}

export function broadcastRecordingFailed(recordingId: string, userId: string, error: string): void {
  emitToUser(userId, 'recording:failed', { recordingId, error });
}

export function broadcastUploadProgress(
  userId: string,
  recordingId: string,
  progress: number,
  uploadedChunks: number,
  totalChunks: number,
): void {
  emitToUser(userId, 'upload:progress', {
    recordingId,
    progress,
    uploadedChunks,
    totalChunks,
  });
}

export function broadcastNewComment(recordingId: string, comment: unknown): void {
  emitToRoom(`recording:${recordingId}`, 'comment:new', comment);
}

export function broadcastNotification(userId: string, notification: unknown): void {
  emitToUser(userId, 'notification:new', notification);
}
