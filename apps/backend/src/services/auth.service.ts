import { addDays } from 'date-fns';
import jwt from 'jsonwebtoken';

import { config } from '../config';
import { prisma } from '../lib/prisma';
import { getUserById as getUserByIdFromTable } from '../lib/users-table';
import { AppError } from '../middleware/errorHandler';

// ============================================================
// Types
// ============================================================

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// ============================================================
// Auth Service
// ============================================================

export class AuthService {
  /**
   * Refresh access token using a valid refresh token.
   * Verifies the Session is valid — no User table lookup needed.
   */
  async refreshToken(refreshToken: string, ip?: string, userAgent?: string): Promise<TokenPair> {
    const session = await prisma.session.findUnique({
      where: { refreshToken },
    });

    if (!session) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
    }

    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { id: session.id } });
      throw new AppError('Refresh token has expired. Please log in again.', 401, 'TOKEN_EXPIRED');
    }

    // Validate the refresh token JWT signature
    let decoded: { userId: string; email: string };
    try {
      decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as {
        userId: string;
        email: string;
      };
    } catch {
      await prisma.session.delete({ where: { id: session.id } });
      throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
    }

    // Generate new token pair (token rotation)
    const tokens = this.generateTokens(decoded.userId, decoded.email);

    await prisma.session.update({
      where: { id: session.id },
      data: {
        refreshToken: tokens.refreshToken,
        expiresAt: addDays(new Date(), 7),
        ip,
        userAgent,
      },
    });

    return tokens;
  }

  /**
   * Invalidate a session (logout).
   */
  async logout(sessionId: string, userId: string): Promise<void> {
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      return; // Already logged out, silently succeed
    }

    await prisma.session.delete({ where: { id: sessionId } });

    await prisma.activityLog.create({
      data: {
        userId,
        action: 'logout',
        resource: 'session',
      },
    });
  }

  /**
   * Logout from all devices.
   */
  async logoutAll(userId: string): Promise<void> {
    await prisma.session.deleteMany({ where: { userId } });
  }

  /**
   * Get user by ID from the external users table.
   */
  async getUserById(userId: string) {
    const user = await getUserByIdFromTable(userId);

    if (!user || !user.isActive) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    return user;
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Generate JWT access token and refresh token pair.
   */
  generateTokens(userId: string, email: string): TokenPair {
    const expiresIn = this.parseExpiresIn(config.jwt.expiresIn);

    const accessToken = jwt.sign(
      { userId, email },
      config.jwt.secret as string,
      {
        expiresIn: config.jwt.expiresIn as string,
      } as Parameters<typeof jwt.sign>[2],
    );

    const refreshToken = jwt.sign(
      { userId, email },
      config.jwt.refreshSecret as string,
      {
        expiresIn: config.jwt.refreshExpiresIn as string,
      } as Parameters<typeof jwt.sign>[2],
    );

    return { accessToken, refreshToken, expiresIn };
  }

  private parseExpiresIn(expiresIn: string): number {
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) {
      return 900; // Default 15 minutes
    }
    const value = parseInt(match[1] ?? '15', 10);
    const unit = match[2];
    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 900;
    }
  }
}

export const authService = new AuthService();
