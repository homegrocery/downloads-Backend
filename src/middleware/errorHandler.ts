import type { Request, Response, NextFunction } from 'express';
import { TelegramService } from '../services/telegramService.js';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  const errorMessage = err?.message || 'INTERNAL_SERVER_ERROR';
  const statusCode = err?.status || (errorMessage.includes('ACCOUNT_LOCKED') || errorMessage.includes('RECOVERY_LOCKED') ? 423 : 400);

  // Notify Telegram Admin for critical 5xx server errors with deduplication
  if (statusCode >= 500) {
    void TelegramService.notifyCriticalError({
      errorType: err?.code || err?.name || 'INTERNAL_SERVER_ERROR',
      message: errorMessage,
      endpoint: req.originalUrl || req.url,
      method: req.method
    }).catch(notifyErr => console.warn('[ErrorHandler] Telegram critical alert notice:', notifyErr?.message));
  }

  res.status(statusCode).json({
    success: false,
    error: errorMessage,
    code: err?.code,
    errorMr: err?.errorMr,
    nextAction: err?.nextAction,
    retryAfter: err?.retryAfter,
    failedAttempts: err?.failedAttempts,
    maxAttempts: err?.maxAttempts,
    remainingAttempts: err?.remainingAttempts,
    lockType: err?.lockType,
    lockReason: err?.lockReason,
    requestId: err?.requestId
  });
}
