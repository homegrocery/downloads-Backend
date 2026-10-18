import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  const errorMessage = err?.message || 'INTERNAL_SERVER_ERROR';
  const statusCode = err?.status || (errorMessage.includes('RECOVERY_LOCKED') ? 423 : 400);

  res.status(statusCode).json({
    success: false,
    error: errorMessage,
    code: err?.code,
    errorMr: err?.errorMr,
    retryAfter: err?.retryAfter,
    remainingAttempts: err?.remainingAttempts
  });
}
