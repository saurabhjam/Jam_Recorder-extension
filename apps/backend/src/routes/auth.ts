import { addDays } from 'date-fns';
import { Router, type Request, type Response, type NextFunction } from 'express';

import { authService } from '../services/auth.service';
import { prisma } from '../lib/prisma';
import { getUserByLogin, getUserByEmail, getUserById, createUser } from '../lib/users-table';
import type { ReportPortalUser } from '../lib/users-table';
import { requireAuth } from '../middleware/auth';
import { authRateLimiter } from '../middleware/rateLimit';
import { config } from '../config';
import { passport } from '../lib/passport';

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
// Shared login handler — used by both /login and /external-login.
// Accepts username OR email + password, calls ReportPortal OAuth,
// and issues our own session tokens.
// ============================================================
async function handleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Accept { username, password } (extension) or { email, password } (dashboard)
    const body = req.body as { username?: string; email?: string; password?: string };
    const password = body.password;
    const credential = body.username ?? body.email; // whichever was supplied

    if (!credential || !password) {
      res.status(400).json({ success: false, message: 'Username/email and password are required' });
      return;
    }

    const ip = req.ip;
    const userAgent = req.get('User-Agent');

    // ── 1. If an email was supplied, resolve the ReportPortal login first ────
    let rpLogin = credential;
    if (credential.includes('@')) {
      const byEmail = await getUserByEmail(credential);
      if (!byEmail) {
        res.status(401).json({
          success: false,
          error: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
        return;
      }
      rpLogin = byEmail.login;
    }

    // ── 2. Call external ReportPortal OAuth endpoint ─────────────────────────
    const oauthRes = await fetch(`${config.externalApi.baseUrl}/uat/sso/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic dWk6dWltYW4=', // base64("ui:uiman") — fixed client credential
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'password', username: rpLogin, password }).toString(),
    });

    if (!oauthRes.ok) {
      res.status(401).json({
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password',
      });
      return;
    }

    const oauthData = (await oauthRes.json()) as {
      access_token: string;
      token_type: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // ── 3. Decode external JWT to get confirmed login name ───────────────────
    try {
      const payload = JSON.parse(
        Buffer.from(oauthData.access_token.split('.')[1]!, 'base64url').toString(),
      ) as Record<string, unknown>;
      rpLogin = (payload['user_name'] ?? payload['sub'] ?? rpLogin) as string;
    } catch {
      // keep rpLogin as-is
    }

    // ── 4. Look up user in the `users` table ─────────────────────────────────
    const user = await getUserByLogin(rpLogin);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found',
      });
      return;
    }

    if (!user.isActive) {
      res.status(401).json({
        success: false,
        error: 'ACCOUNT_DEACTIVATED',
        message: 'Account is deactivated',
      });
      return;
    }

    // ── 5. Issue our own session tokens ──────────────────────────────────────
    const tokens = authService.generateTokens(user.id, user.email);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken: tokens.refreshToken,
        ip,
        userAgent,
        expiresAt: addDays(new Date(), 7),
      },
    });

    await prisma.activityLog.create({
      data: { userId: user.id, action: 'login', resource: 'session', ip, userAgent },
    });

    res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, COOKIE_OPTIONS);

    res.json({
      success: true,
      message: 'Logged in successfully',
      data: {
        user: {
          id: user.id,
          login: user.login,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          role: user.role,
          isActive: user.isActive,
        },
        tokens: {
          ...buildTokensPayload(tokens),
          externalToken: oauthData.access_token,
          externalTokenExpiresAt: oauthData.expires_in
            ? Date.now() + oauthData.expires_in * 1000
            : undefined,
        },
        sessionId: session.id,
      },
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================
// POST /auth/login  (dashboard — sends { email, password })
// POST /auth/external-login  (extension — sends { username, password })
// Both delegate to the shared handleLogin function above.
// ============================================================
router.post('/login', authRateLimiter, handleLogin);
router.post('/external-login', authRateLimiter, handleLogin);

// ============================================================
// POST /auth/register
// Creates a new user in the `users` table (INTERNAL type),
// then issues session tokens exactly like login.
// Body: { name, email, password }
// ============================================================
router.post(
  '/register',
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, email, password } = req.body as {
        name?: string;
        email?: string;
        password?: string;
      };

      if (!name || !email || !password) {
        res.status(400).json({ success: false, message: 'Name, email, and password are required' });
        return;
      }

      if (password.length < 6) {
        res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        return;
      }

      // Check for duplicate email
      const existing = await getUserByEmail(email);
      if (existing) {
        res.status(409).json({
          success: false,
          error: 'DUPLICATE_ERROR',
          message: 'An account with this email already exists',
        });
        return;
      }

      const ip = req.ip;
      const userAgent = req.get('User-Agent');

      // Create the user in the `users` table
      const user = await createUser({ name, email, password });

      // Issue session tokens
      const tokens = authService.generateTokens(user.id, user.email);
      const session = await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: tokens.refreshToken,
          ip,
          userAgent,
          expiresAt: addDays(new Date(), 7),
        },
      });

      await prisma.activityLog.create({
        data: { userId: user.id, action: 'register', resource: 'user', ip, userAgent },
      });

      res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, COOKIE_OPTIONS);

      res.status(201).json({
        success: true,
        message: 'Account created successfully',
        data: {
          user: {
            id: user.id,
            login: user.login,
            email: user.email,
            name: user.name,
            avatar: user.avatar,
            role: user.role,
            isActive: user.isActive,
          },
          tokens: buildTokensPayload(tokens),
          sessionId: session.id,
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
      const user = await getUserById(req.user!.id);
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================
// GET /auth/google
// Redirects to Google consent screen.
// ============================================================
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false }),
);

// ============================================================
// GET /auth/google/callback
// Google redirects here after consent. Issues our own session
// tokens and redirects the browser to the frontend.
// ============================================================
router.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${config.server.frontendUrl}/login?error=google_failed`,
  }),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = req.user as ReportPortalUser;
      const ip = req.ip;
      const userAgent = req.get('User-Agent');

      const tokens = authService.generateTokens(user.id, user.email);
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: tokens.refreshToken,
          ip,
          userAgent,
          expiresAt: addDays(new Date(), 7),
        },
      });

      await prisma.activityLog.create({
        data: { userId: user.id, action: 'login', resource: 'session', ip, userAgent },
      });

      const tokensPayload = buildTokensPayload(tokens);
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
