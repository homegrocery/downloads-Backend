import { Router } from 'express';
import { AuthService } from '../services/authService.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { normalizeMobileNumber } from '../utils/validation.js';

export const authRouter = Router();

// Rate limiter for auth endpoints: max 15 attempts per minute
const authLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 15 });

// Rate limiter for recovery verification and reset endpoints (keyed by IP and normalized account)
const recoveryLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyGenerator: (req) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const mobile = req.body?.mobileNumber ? normalizeMobileNumber(req.body.mobileNumber) || '' : '';
    return `${ip}:${mobile}`;
  }
});

authRouter.post('/register', authLimiter, (req, res, next) => {
  try {
    const { mobileNumber, pin, fullName, preferredLanguage, deviceInfo, pinLength } = req.body;
    const result = AuthService.register({
      mobileNumber,
      pin,
      fullName,
      preferredLanguage,
      deviceInfo,
      pinLength: pinLength ? Number(pinLength) as (4 | 6) : undefined
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      messageMr: 'खाते यशस्वीरित्या तयार झाले',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', authLimiter, (req, res, next) => {
  try {
    const { mobileNumber, pin, deviceInfo } = req.body;
    const result = AuthService.login({
      mobileNumber,
      pin,
      deviceInfo
    });

    res.json({
      success: true,
      message: 'Logged in successfully',
      messageMr: 'लॉगिन यशस्वी झाले',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    AuthService.logout(token);
  }
  res.json({
    success: true,
    message: 'Logged out successfully',
    messageMr: 'लॉगआउट यशस्वी झाले'
  });
});

authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({
    success: true,
    data: {
      user: req.user
    }
  });
});

authRouter.post('/change-pin', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    const { currentPin, newPin, newPinLength } = req.body;
    AuthService.changePin(
      req.user!.id,
      currentPin,
      newPin,
      newPinLength ? Number(newPinLength) as (4 | 6) : undefined
    );

    res.json({
      success: true,
      message: 'PIN changed successfully. Please log in with your new PIN.',
      messageMr: 'पिन यशस्वीरित्या बदलला. कृपया नवीन पिनने पुन्हा लॉगिन करा.'
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/recovery-code/generate', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    const result = AuthService.generateRecoveryCodeForUser(req.user!.id);
    res.json({
      success: true,
      message: result.isReplacement ? 'Replacement Recovery Code generated' : 'Recovery Code generated',
      messageMr: result.isReplacement ? 'नवीन रिकव्हरी कोड तयार झाला' : 'रिकव्हरी कोड तयार झाला',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/recovery-code/status', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    const status = AuthService.getRecoveryCodeStatus(req.user!.id);
    res.json({
      success: true,
      data: status
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/verify-recovery-code', recoveryLimiter, (req, res, next) => {
  try {
    const { mobileNumber, recoveryCode } = req.body;
    const result = AuthService.verifyRecoveryCode(mobileNumber, recoveryCode);
    res.json({
      success: true,
      message: 'Recovery Code verified successfully',
      messageMr: 'रिकव्हरी कोड यशस्वीरित्या पडताळला',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-pin-recovery', recoveryLimiter, (req, res, next) => {
  try {
    const { mobileNumber, resetToken, newPin, confirmPin, newPinLength } = req.body;
    const result = AuthService.resetPinWithRecoveryCode({
      mobileNumber,
      resetToken,
      newPin,
      confirmPin,
      newPinLength: newPinLength ? (Number(newPinLength) as 4 | 6) : undefined
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-pin-otp', authLimiter, async (req, res, next) => {
  try {
    const { mobileNumber, newPin, newPinLength, firebaseIdToken } = req.body;
    const result = await AuthService.resetPinWithOtp({
      mobileNumber,
      newPin,
      newPinLength: newPinLength ? Number(newPinLength) as (4 | 6) : undefined,
      firebaseIdToken
    });

    res.json({
      success: true,
      message: result.message,
      messageMr: result.messageMr
    });
  } catch (err) {
    next(err);
  }
});
