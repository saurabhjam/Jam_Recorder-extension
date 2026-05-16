import rateLimit from 'express-rate-limit';

import { config } from '../config';

// ============================================================
// Auth Rate Limiter (stricter)
// ============================================================

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
  },
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
  },
});

// ============================================================
// General API Rate Limiter
// ============================================================

export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests. Please slow down.',
  },
  skip: (req) => {
    // Skip health check endpoint
    return req.path === '/health';
  },
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise use IP
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
  },
});

// ============================================================
// Upload Rate Limiter
// ============================================================

export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 chunks per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Upload rate limit exceeded. Please slow down your uploads.',
  },
  keyGenerator: (req) => {
    if (req.user?.id) {
      return `upload:${req.user.id}`;
    }
    return req.ip ?? 'unknown';
  },
});

// ============================================================
// Share View Rate Limiter
// ============================================================

export const shareViewRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests.',
  },
});
