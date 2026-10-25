import { Router } from 'express';
import { ReactivationRequestService } from '../services/reactivationRequestService.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';

export const reactivationRequestRouter = Router();

// Rate limiter for reactivation requests: max 10 requests per minute
const requestLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10
});

reactivationRequestRouter.post('/', requestLimiter, (req, res, next) => {
  try {
    const { mobileNumber, reason } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = ReactivationRequestService.createRequest({
      mobileNumber,
      reason,
      ipAddress: ip
    });

    res.status(201).json({
      success: true,
      message: 'Reactivation request submitted successfully. Administrator will review it.',
      messageMr: 'खाते पुन्हा सुरू करण्याची विनंती सादर केली आहे. प्रशासक याचे पुनरावलोकन करतील.',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

reactivationRequestRouter.get('/status', (req, res, next) => {
  try {
    const mobileNumber = (req.query.mobileNumber as string) || (req.query.mobile as string);
    const requestId = req.query.requestId as string | undefined;

    const result = ReactivationRequestService.getRequestStatus({
      mobileNumber,
      requestId
    });

    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
});
