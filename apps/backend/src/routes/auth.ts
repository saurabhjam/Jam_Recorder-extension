import { Router, type Request, type Response, type NextFunction } from 'express';

import { authService } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { authRateLimiter } from '../middleware/rateLimit';
import {
  loginSchema,
  registerSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../schemas/auth.schema';
import { config } from '../config';
import { passport } from '../lib/passport';
import type { User } from '@prisma/client';

const router = Router();

const REFRESH_COOKIE_NAME = 'refresh_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.server.isProd,
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Build the canonical tokens payload the extension expects:
 *   { accessToken, refreshToken, expiresAt (Unix ms) }
 *
 * expiresIn comes from authService.generateTokens as seconds.
 */
function buildTokensPayload(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  };
}

// ============================================================
// POST /auth/register
// ============================================================
router.post(
  '/register',
  authRateLimiter,
  validate(registerSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = req.ip;
      const userAgent = req.get('User-Agent');
      const result = await authService.register(req.body, ip, userAgent);

      res.cookie(REFRESH_COOKIE_NAME, result.tokens.refreshToken, COOKIE_OPTIONS);

      res.status(201).json({
        success: true,
        message: 'Account created successfully',
        data: {
          user: result.user,
          tokens: buildTokensPayload(result.tokens),
          sessionId: result.sessionId,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /auth/login
// ============================================================
router.post(
  '/login',
  authRateLimiter,
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = req.ip;
      const userAgent = req.get('User-Agent');
      const result = await authService.login(req.body, ip, userAgent);

      res.cookie(REFRESH_COOKIE_NAME, result.tokens.refreshToken, COOKIE_OPTIONS);

      res.json({
        success: true,
        message: 'Logged in successfully',
        data: {
          user: result.user,
          tokens: buildTokensPayload(result.tokens),
          sessionId: result.sessionId,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /auth/refresh
// The extension stores tokens in chrome.storage (not cookies) so
// the new refresh token MUST be in the response body as well.
// ============================================================
router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const refreshToken =
      (req.cookies as Record<string, string>)[REFRESH_COOKIE_NAME] ??
      (req.body as { refreshToken?: string }).refreshToken;

    if (!refreshToken) {
      res.status(401).json({
        success: false,
        error: 'NO_REFRESH_TOKEN',
        message: 'No refresh token provided',
      });
      return;
    }

    const ip = req.ip;
    const userAgent = req.get('User-Agent');
    const tokens = await authService.refreshToken(refreshToken, ip, userAgent);

    // Set cookie AND return token in body so the extension can store it
    res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, COOKIE_OPTIONS);

    res.json({
      success: true,
      data: {
        tokens: buildTokensPayload(tokens),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// POST /auth/logout
// ============================================================
router.post(
  '/logout',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId, logoutAll } = req.body as {
        sessionId?: string;
        logoutAll?: boolean;
      };

      if (req.user) {
        if (logoutAll) {
          await authService.logoutAll(req.user.id);
        } else if (sessionId) {
          await authService.logout(sessionId, req.user.id);
        }
      }

      res.clearCookie(REFRESH_COOKIE_NAME);

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /auth/me
// ============================================================
router.get(
  '/me',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await authService.getUserById(req.user!.id);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// PUT /auth/me
// ============================================================
router.put(
  '/me',
  requireAuth,
  validate(updateProfileSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const updated = await authService.updateProfile(req.user!.id, req.body);
      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /auth/forgot-password
// ============================================================
router.post(
  '/forgot-password',
  authRateLimiter,
  validate(forgotPasswordSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email } = req.body as { email: string };
      await authService.forgotPassword(email);
      res.json({
        success: true,
        message: 'If an account with that email exists, a reset link has been sent.',
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// POST /auth/reset-password
// ============================================================
router.post(
  '/reset-password',
  authRateLimiter,
  validate(resetPasswordSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { token, newPassword } = req.body as { token: string; newPassword: string };
      await authService.resetPassword(token, newPassword);
      res.json({
        success: true,
        message: 'Password reset successfully. Please log in with your new password.',
      });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /auth/google — initiate Google OAuth
// ============================================================
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false }),
);

// ============================================================
// GET /auth/google/callback — Google OAuth callback
// ============================================================
router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: `${config.server.frontendUrl}/login?error=oauth_failed`,
    session: false,
  }),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const googleUser = req.user as User;

      const { tokens } = await authService.handleGoogleCallback(
        googleUser.googleId!,
        googleUser.email,
        googleUser.name,
        googleUser.avatar ?? undefined,
      );

      // Build the canonical tokens payload
      const tokensPayload = buildTokensPayload(tokens);

      // Set cookie for web clients
      res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, COOKIE_OPTIONS);

      // Redirect with all token data in query params so
      // both the web dashboard and the extension can consume them.
      const redirectUrl = new URL(`${config.server.frontendUrl}/auth/callback`);
      redirectUrl.searchParams.set('accessToken', tokensPayload.accessToken);
      redirectUrl.searchParams.set('refreshToken', tokensPayload.refreshToken);
      redirectUrl.searchParams.set('expiresAt', String(tokensPayload.expiresAt));

      res.redirect(redirectUrl.toString());
    } catch (error) {
      next(error);
    }
  },
);

export default router;
