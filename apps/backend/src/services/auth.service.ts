import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { addDays, addMinutes } from 'date-fns';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';

import { config } from '../config';
import { prisma } from '../lib/prisma';
import { sendPasswordResetEmail } from '../lib/mailer';
import { AppError } from '../middleware/errorHandler';
import type { LoginInput, RegisterInput } from '../schemas/auth.schema';
import { generateSecureToken } from '../utils/crypto';

// ============================================================
// Types
// ============================================================

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

type AuthTokens = TokenPair;

interface AuthResult {
  user: {
    id: string;
    email: string;
    name: string;
    avatar: string | null;
    teamId: string | null;
    isVerified: boolean;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  tokens: TokenPair;
  sessionId: string;
}

// ============================================================
// Auth Service
// ============================================================

export class AuthService {
  private readonly prisma = prisma;

  /**
   * Register a new user.
   */
  async register(data: RegisterInput, ip?: string, userAgent?: string): Promise<AuthResult> {
    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    });

    if (existingUser) {
      throw new AppError('An account with this email already exists', 409, 'DUPLICATE_ERROR');
    }

    const hashedPassword = await this.hashPassword(data.password);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        password: hashedPassword,
        isVerified: false,
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        teamId: true,
        isVerified: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const tokens = this.generateTokens(user.id, user.email);
    const session = await this.createSession(user.id, tokens.refreshToken, ip, userAgent);

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'register',
        resource: 'user',
        ip,
        userAgent,
      },
    });

    return { user, tokens, sessionId: session.id };
  }

  /**
   * Authenticate a user with email and password.
   */
  async login(data: LoginInput, ip?: string, userAgent?: string): Promise<AuthResult> {
    const user = await prisma.user.findUnique({
      where: { email: data.email },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        password: true,
        teamId: true,
        isVerified: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      // Use same error for security (prevents user enumeration)
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
      throw new AppError(
        'Account has been deactivated. Contact support.',
        401,
        'ACCOUNT_DEACTIVATED',
      );
    }

    const isPasswordValid = await this.comparePassword(data.password, user.password);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const tokens = this.generateTokens(user.id, user.email);
    const session = await this.createSession(user.id, tokens.refreshToken, ip, userAgent);

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'login',
        resource: 'session',
        ip,
        userAgent,
      },
    });

    const { password: _, ...userWithoutPassword } = user;
    return { user: userWithoutPassword, tokens, sessionId: session.id };
  }

  /**
   * Refresh access token using a valid refresh token.
   */
  async refreshToken(refreshToken: string, ip?: string, userAgent?: string): Promise<TokenPair> {
    // Find and validate session
    const session = await prisma.session.findUnique({
      where: { refreshToken },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            isActive: true,
          },
        },
      },
    });

    if (!session) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
    }

    if (session.expiresAt < new Date()) {
      // Delete expired session
      await prisma.session.delete({ where: { id: session.id } });
      throw new AppError('Refresh token has expired. Please log in again.', 401, 'TOKEN_EXPIRED');
    }

    if (!session.user.isActive) {
      throw new AppError('Account is deactivated', 401, 'ACCOUNT_DEACTIVATED');
    }

    // Validate the refresh token JWT
    try {
      jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch {
      await prisma.session.delete({ where: { id: session.id } });
      throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
    }

    // Generate new token pair (token rotation)
    const tokens = this.generateTokens(session.user.id, session.user.email);

    // Update session with new refresh token
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
   * Get user by ID, stripping sensitive fields.
   */
  async getUserById(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        teamId: true,
        isVerified: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        team: {
          select: {
            id: true,
            name: true,
            slug: true,
            plan: true,
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    return user;
  }

  /**
   * Update user profile.
   */
  async updateProfile(userId: string, data: { name?: string; avatar?: string | null }) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.avatar !== undefined && { avatar: data.avatar }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        teamId: true,
        isVerified: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Send a password-reset email. Always resolves (no email enumeration).
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;

    // Invalidate any existing reset tokens for this user
    await this.prisma.passwordReset.deleteMany({ where: { userId: user.id } });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.passwordReset.create({
      data: { userId: user.id, token, expiresAt },
    });

    await sendPasswordResetEmail(user.email, user.name, token);
  }

  /**
   * Reset a user's password via a valid reset token.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const reset = await this.prisma.passwordReset.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new AppError('Invalid or expired reset token', 400, 'INVALID_TOKEN');
    }

    const hashed = await this.hashPassword(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: reset.userId },
        data: { password: hashed },
      }),
      this.prisma.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
      // Invalidate all sessions
      this.prisma.session.deleteMany({ where: { userId: reset.userId } }),
    ]);
  }

  /**
   * Handle Google OAuth callback — upsert user and issue JWT tokens.
   */
  async handleGoogleCallback(
    googleId: string,
    email: string,
    name: string,
    avatar?: string,
  ): Promise<{ user: User; tokens: AuthTokens }> {
    let user = await this.prisma.user.findFirst({
      where: { OR: [{ googleId }, { email }] },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: { email, name, googleId, avatar, password: '', isVerified: true },
      });
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { googleId, avatar: user.avatar ?? avatar, isVerified: true },
      });
    }

    const tokens = this.generateTokens(user.id, user.email);
    await this.createSession(user.id, tokens.refreshToken);
    return { user, tokens };
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  /**
   * Generate JWT access token and refresh token pair.
   */
  generateTokens(userId: string, email: string): TokenPair {
    const expiresIn = this.parseExpiresIn(config.jwt.expiresIn);

    const accessToken = jwt.sign({ userId, email }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    const refreshToken = jwt.sign({ userId, email }, config.jwt.refreshSecret, {
      expiresIn: config.jwt.refreshExpiresIn,
    });

    return { accessToken, refreshToken, expiresIn };
  }

  /**
   * Hash a password using bcrypt.
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, config.auth.bcryptRounds);
  }

  /**
   * Compare a plain password against a bcrypt hash.
   */
  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  private async createSession(
    userId: string,
    refreshToken: string,
    ip?: string,
    userAgent?: string,
  ) {
    return prisma.session.create({
      data: {
        userId,
        refreshToken,
        ip,
        userAgent,
        expiresAt: addDays(new Date(), 7),
      },
    });
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
