import type { NextFunction, Request, Response } from 'express';

import { type ZodSchema } from 'zod';

import { AppError } from './errorHandler';

type ValidateTarget = 'body' | 'query' | 'params';

/**
 * Middleware factory that validates request data against a Zod schema.
 * Defaults to validating req.body.
 */
export function validate<T>(schema: ZodSchema<T>, target: ValidateTarget = 'body') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = req[target];
      const result = await schema.safeParseAsync(data);

      if (!result.success) {
        const details = result.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
          code: e.code,
        }));

        return next(new AppError('Validation failed', 422, 'VALIDATION_ERROR', details));
      }

      // Replace the request target with parsed (transformed) data
      (req as Record<string, unknown>)[target] = result.data;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validates multiple targets in one middleware.
 */
export function validateRequest<TBody = unknown, TQuery = unknown, TParams = unknown>(schemas: {
  body?: ZodSchema<TBody>;
  query?: ZodSchema<TQuery>;
  params?: ZodSchema<TParams>;
}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const errors: Array<{ field: string; message: string; code: string }> = [];

      for (const [target, schema] of Object.entries(schemas) as [ValidateTarget, ZodSchema][]) {
        const data = req[target];
        const result = await schema.safeParseAsync(data);

        if (!result.success) {
          for (const e of result.error.errors) {
            errors.push({
              field: `${target}.${e.path.join('.')}`,
              message: e.message,
              code: e.code,
            });
          }
        } else {
          (req as Record<string, unknown>)[target] = result.data;
        }
      }

      if (errors.length > 0) {
        return next(new AppError('Validation failed', 422, 'VALIDATION_ERROR', errors));
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
