import { Router } from 'express';
import { RecoveryRequestService } from '../services/recoveryRequestService.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { normalizeMobileNumber } from '../utils/validation.js';

export const recoveryRequestsRouter = Router();

// Rate limiter for recovery requests (keyed by IP and normalized account)
const requestLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  keyGenerator: (req) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const mobile = req.body?.mobileNumber ? normalizeMobileNumber(req.body.mobileNumber) || '' : '';
    return `${ip}:${mobile}`;
  }
});

// User submits an Admin Recovery request
recoveryRequestsRouter.post('/', requestLimiter, (req, res, next) => {
  try {
    const { mobileNumber } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = RecoveryRequestService.createRequest({
      mobileNumber,
      ipAddress: ip
    });

    res.status(201).json({
      success: true,
      message: 'Recovery request submitted successfully',
      messageMr: 'रिकव्हरी विनंती यशस्वीरित्या पाठवली आहे',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// User checks status of an Admin Recovery request using capability token
recoveryRequestsRouter.get('/status', (req, res, next) => {
  try {
    const requestId = (req.headers['x-recovery-request-id'] as string) || (req.query.requestId as string);
    const requestToken = (req.headers['x-recovery-token'] as string) || (req.query.requestToken as string);

    const result = RecoveryRequestService.getRequestStatus(requestId, requestToken);
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// User cancels an Admin Recovery request using capability token
recoveryRequestsRouter.delete('/', (req, res, next) => {
  try {
    const requestId = (req.headers['x-recovery-request-id'] as string) || (req.body?.requestId as string);
    const requestToken = (req.headers['x-recovery-token'] as string) || (req.body?.requestToken as string);

    const success = RecoveryRequestService.cancelRequest(requestId, requestToken);
    res.json({
      success,
      message: 'Recovery request cancelled',
      messageMr: 'रिकव्हरी विनंती रद्द केली आहे'
    });
  } catch (err) {
    next(err);
  }
});
