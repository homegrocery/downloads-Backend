import type { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService.js';
import { SecurityService } from '../services/securityService.js';
import type { SafeUser } from '../types/index.js';

export interface AuthenticatedRequest extends Request {
  user?: SafeUser;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'AUTH_REQUIRED: Please log in to access this resource',
      code: 'AUTH_REQUIRED',
      reasonCode: 'AUTH_REQUIRED',
      errorMr: 'कृपया या सुविधेसाठी प्रथम लॉगिन करा',
      nextAction: 'LOGIN_REQUIRED'
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  const sessionResult = AuthService.verifySessionWithStatus(token);

  if (sessionResult.status === 'VALID' && sessionResult.user) {
    req.user = sessionResult.user;
    next();
    return;
  }

  if (sessionResult.status === 'LOCKED') {
    res.status(401).json({
      success: false,
      error: sessionResult.error || 'ACCOUNT_LOCKED: Your account has been locked.',
      code: sessionResult.code || 'ACCOUNT_LOCKED',
      reasonCode: sessionResult.reasonCode || 'ACCOUNT_LOCKED_PIN_ATTEMPTS',
      errorMr: sessionResult.errorMr || 'वारंवार चुकीचा पिन टाकल्यामुळे तुमचे खाते लॉक केले आहे. पुन्हा प्रवेश मिळवण्यासाठी खाते पुन्हा सुरू करण्याची विनंती करा.',
      lockType: sessionResult.lockType || 'AUTOMATIC',
      lockReason: sessionResult.lockReason || null,
      failedAttempts: sessionResult.failedAttempts || 5,
      maxAttempts: 5,
      remainingAttempts: 0,
      nextAction: 'REACTIVATION_REQUIRED'
    });
    return;
  }

  if (sessionResult.status === 'REVOKED') {
    res.status(401).json({
      success: false,
      error: sessionResult.error || 'SESSION_REVOKED_SECURITY: Your session has been revoked for security reasons. Please sign in again.',
      code: 'SESSION_REVOKED_SECURITY',
      reasonCode: sessionResult.reasonCode || 'SESSION_REVOKED_SECURITY',
      errorMr: sessionResult.errorMr || 'सुरक्षिततेच्या कारणामुळे तुमचे सत्र रद्द केले आहे. कृपया पुन्हा लॉगिन करा. खाते लॉक असल्यास खाते पुनर्प्राप्ती किंवा पुन्हा सुरू करण्याच्या सूचनांचे पालन करा.',
      nextAction: 'LOGIN_REQUIRED'
    });
    return;
  }

  res.status(401).json({
    success: false,
    error: sessionResult.error || 'SESSION_EXPIRED: Your session has expired. Please sign in again.',
    code: 'SESSION_EXPIRED',
    reasonCode: 'SESSION_EXPIRED',
    errorMr: sessionResult.errorMr || 'आपले सत्र संपले आहे. कृपया पुन्हा लॉगिन करा.',
    nextAction: 'LOGIN_REQUIRED'
  });
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'AUTH_REQUIRED: Admin credentials required to access this resource',
      code: 'AUTH_REQUIRED',
      reasonCode: 'AUTH_REQUIRED',
      errorMr: 'या सुविधेसाठी प्रशासक लॉगिन आवश्यक आहे',
      nextAction: 'LOGIN_REQUIRED'
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  const sessionResult = AuthService.verifySessionWithStatus(token);

  if (sessionResult.status === 'LOCKED') {
    res.status(423).json({
      success: false,
      error: sessionResult.error || 'ACCOUNT_LOCKED: Your account has been locked.',
      code: sessionResult.code || 'ACCOUNT_LOCKED',
      reasonCode: sessionResult.reasonCode || 'ACCOUNT_LOCKED_PIN_ATTEMPTS',
      errorMr: sessionResult.errorMr,
      lockType: sessionResult.lockType || 'AUTOMATIC',
      lockReason: sessionResult.lockReason,
      nextAction: 'REACTIVATION_REQUIRED'
    });
    return;
  }

  if (sessionResult.status === 'REVOKED') {
    res.status(401).json({
      success: false,
      error: sessionResult.error || 'SESSION_REVOKED_SECURITY: Your session has been revoked for security reasons.',
      code: 'SESSION_REVOKED_SECURITY',
      reasonCode: 'SESSION_REVOKED_SECURITY',
      errorMr: sessionResult.errorMr,
      nextAction: 'LOGIN_REQUIRED'
    });
    return;
  }

  if (sessionResult.status !== 'VALID' || !sessionResult.user) {
    res.status(401).json({
      success: false,
      error: sessionResult.error || 'SESSION_EXPIRED: Your admin session has expired or is invalid. Please log in again.',
      code: 'SESSION_EXPIRED',
      reasonCode: 'SESSION_EXPIRED',
      errorMr: sessionResult.errorMr || 'आपले प्रशासक सत्र संपले आहे. कृपया पुन्हा लॉगिन करा.',
      nextAction: 'LOGIN_REQUIRED'
    });
    return;
  }

  const user = sessionResult.user;

  if (user.role !== 'admin') {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const probeResult = SecurityService.recordAdminAccessAttempt(
      user.id,
      user.mobile_number,
      ip,
      req.originalUrl || req.url,
      req.method
    );

    if (probeResult.shouldRevokeSession) {
      res.status(401).json({
        success: false,
        error: 'SESSION_REVOKED_SECURITY: Your session has been revoked for security reasons. Please sign in again.',
        code: 'SESSION_REVOKED_SECURITY',
        reasonCode: 'SESSION_REVOKED_SECURITY',
        errorMr: 'सुरक्षिततेच्या कारणामुळे तुमचे सत्र रद्द केले आहे. कृपया पुन्हा लॉगिन करा.',
        nextAction: 'LOGIN_REQUIRED'
      });
      return;
    }

    res.status(403).json({
      success: false,
      error: 'ADMIN_FORBIDDEN: Access denied. Administrator privileges required.',
      code: 'UNAUTHORIZED_ACTION',
      reasonCode: 'UNAUTHORIZED_ACTION',
      errorMr: 'प्रवेश नाकारला. प्रशासक विशेषाधिकार आवश्यक आहेत.'
    });
    return;
  }

  req.user = user;
  next();
}
