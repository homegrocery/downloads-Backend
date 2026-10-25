import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  const errorMessage = err?.message || 'INTERNAL_SERVER_ERROR';
  const statusCode = err?.status || (errorMessage.includes('ACCOUNT_LOCKED') || errorMessage.includes('RECOVERY_LOCKED') ? 423 : 400);

  res.status(statusCode).json({
    success: false,
    error: errorMessage,
    code: err?.code,
    errorMr: err?.errorMr,
    retryAfter: err?.retryAfter,
    failedAttempts: err?.failedAttempts,
    maxAttempts: err?.maxAttempts,
    remainingAttempts: err?.remainingAttempts,
    lockType: err?.lockType,
    lockReason: err?.lockReason,
    requestId: err?.requestId
  });
}
