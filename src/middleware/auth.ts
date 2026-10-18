import type { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService.js';
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
      errorMr: 'कृपया या सुविधेसाठी प्रथम लॉगिन करा'
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  const user = AuthService.verifySession(token);

  if (!user) {
    res.status(401).json({
      success: false,
      error: 'SESSION_EXPIRED: Your session has expired or is invalid. Please log in again.',
      errorMr: 'आपले सत्र संपले आहे. कृपया पुन्हा लॉगिन करा.'
    });
    return;
  }

  req.user = user;
  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'AUTH_REQUIRED: Admin credentials required to access this resource',
      errorMr: 'या सुविधेसाठी प्रशासक लॉगिन आवश्यक आहे'
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  const user = AuthService.verifySession(token);

  if (!user) {
    res.status(401).json({
      success: false,
      error: 'SESSION_EXPIRED: Your admin session has expired or is invalid. Please log in again.',
      errorMr: 'आपले प्रशासक सत्र संपले आहे. कृपया पुन्हा लॉगिन करा.'
    });
    return;
  }

  if (user.role !== 'admin') {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    // Record unauthorized admin route access attempt
    try {
      import('../services/adminService.js').then(({ AdminService }) => {
        AdminService.logAudit({
          adminUserId: user.id,
          action: 'UNAUTHORIZED_ADMIN_API_ACCESS_ATTEMPT',
          targetAccountId: user.id,
          targetMobileNumber: user.mobile_number,
          details: { path: req.originalUrl, method: req.method },
          ipAddress: ip
        });
      });
    } catch {
      // ignore
    }

    res.status(403).json({
      success: false,
      error: 'ADMIN_FORBIDDEN: Access denied. Administrator privileges required.',
      errorMr: 'प्रवेश नाकारला. प्रशासक विशेषाधिकार आवश्यक आहेत.'
    });
    return;
  }

  req.user = user;
  next();
}
