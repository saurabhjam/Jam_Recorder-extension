import type { NextFunction, Request, Response } from 'express';

import jwt from 'jsonwebtoken';

import { config } from '../config';
import { getUserById } from '../lib/users-table';
import { AppError } from './errorHandler';

export interface JwtPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

// Augment Express types globally.
// Passport declares req.user as Express.User — we extend that interface here
// rather than redeclaring req.user, which would cause TS2717.
declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      avatar: string | null;
      role: string;
      isActive: boolean;
      isExpired: boolean;
    }
    interface Request {
      sessionId?: string;
    }
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Also check query param for WebSocket upgrades
  if (req.query['token'] && typeof req.query['token'] === 'string') {
    return req.query['token'];
  }
  return null;
}

export async function verifyToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      throw new AppError('No authentication token provided', 401, 'UNAUTHORIZED');
    }

    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError('Access token expired', 401, 'TOKEN_EXPIRED');
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new AppError('Invalid access token', 401, 'INVALID_TOKEN');
      }
      throw err;
    }

    const user = await getUserById(decoded.userId);

    if (!user) {
      throw new AppError('User not found', 401, 'USER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new AppError('Account is deactivated', 401, 'ACCOUNT_DEACTIVATED');
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export const requireAuth = verifyToken;

export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      if (roles.includes('OWNER') && !roles.includes(req.user.role)) {
        throw new AppError('Insufficient permissions', 403, 'FORBIDDEN');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      return next();
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
      const user = await getUserById(decoded.userId);

      if (user && user.isActive) {
        req.user = user;
      }
    } catch {
      // Ignore token errors for optional auth
    }

    next();
  } catch (error) {
    next(error);
  }
}
