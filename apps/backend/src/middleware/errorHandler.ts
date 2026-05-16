import type { NextFunction, Request, Response } from 'express';

import { Prisma } from '@prisma/client';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { ZodError } from 'zod';

import { config } from '../config';

// ============================================================
// Custom Application Error
// ============================================================

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================================
// Error Response Shape
// ============================================================

interface ErrorResponse {
  success: false;
  error: string;
  message: string;
  code?: string;
  details?: unknown;
  stack?: string;
}

// ============================================================
// Global Error Handler Middleware
// ============================================================

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let statusCode = 500;
  let message = 'Internal server error';
  let code = 'INTERNAL_ERROR';
  let details: unknown;

  // AppError (operational errors)
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    code = err.code;
    details = err.details;
  }

  // Prisma Errors
  else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        // Unique constraint violation
        const field = (err.meta?.target as string[])?.join(', ') ?? 'field';
        statusCode = 409;
        message = `A record with this ${field} already exists`;
        code = 'DUPLICATE_ERROR';
        break;
      }
      case 'P2025': {
        // Record not found
        statusCode = 404;
        message = 'Record not found';
        code = 'NOT_FOUND';
        break;
      }
      case 'P2003': {
        // Foreign key constraint
        statusCode = 400;
        message = 'Related record not found';
        code = 'FOREIGN_KEY_ERROR';
        break;
      }
      case 'P2014': {
        statusCode = 400;
        message = 'Invalid relation';
        code = 'INVALID_RELATION';
        break;
      }
      default: {
        statusCode = 400;
        message = 'Database error';
        code = 'DATABASE_ERROR';
        if (config.server.isDev) {
          details = { prismaCode: err.code, meta: err.meta };
        }
      }
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    statusCode = 400;
    message = 'Invalid data provided';
    code = 'VALIDATION_ERROR';
    if (config.server.isDev) {
      details = err.message;
    }
  } else if (err instanceof Prisma.PrismaClientInitializationError) {
    statusCode = 503;
    message = 'Database connection failed';
    code = 'DATABASE_UNAVAILABLE';
  }

  // Zod Validation Errors
  else if (err instanceof ZodError) {
    statusCode = 422;
    message = 'Validation failed';
    code = 'VALIDATION_ERROR';
    details = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
      code: e.code,
    }));
  }

  // JWT Errors
  else if (err instanceof TokenExpiredError) {
    statusCode = 401;
    message = 'Access token has expired';
    code = 'TOKEN_EXPIRED';
  } else if (err instanceof JsonWebTokenError) {
    statusCode = 401;
    message = 'Invalid access token';
    code = 'INVALID_TOKEN';
  }

  // Multer Errors
  else if (err.name === 'MulterError') {
    const multerErr = err as Error & { code: string; field?: string };
    statusCode = 400;
    code = 'UPLOAD_ERROR';
    switch (multerErr.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File size exceeds the maximum allowed limit';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files uploaded';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = `Unexpected file field: ${multerErr.field ?? 'unknown'}`;
        break;
      default:
        message = 'File upload error';
    }
  }

  // SyntaxError (invalid JSON body)
  else if (err instanceof SyntaxError && 'body' in err) {
    statusCode = 400;
    message = 'Invalid JSON in request body';
    code = 'INVALID_JSON';
  }

  // Log non-operational errors
  const isOperational = err instanceof AppError && err.isOperational;
  if (!isOperational) {
    console.error('[Error]', {
      name: err.name,
      message: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      userId: req.user?.id,
    });
  }

  const response: ErrorResponse = {
    success: false,
    error: code,
    message,
    ...(details !== undefined && { details }),
    ...(config.server.isDev && { stack: err.stack }),
  };

  res.status(statusCode).json(response);
}

// ============================================================
// 404 Not Found Handler
// ============================================================

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(`Route not found: ${req.method} ${req.path}`, 404, 'NOT_FOUND'));
}
