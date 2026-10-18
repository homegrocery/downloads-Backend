import { Router } from 'express';
import { AdminService } from '../services/adminService.js';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';

export const adminRouter = Router();

// Rate limiter for admin login: max 10 requests per 15 minutes
const adminLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10
});

// Admin Login
adminRouter.post('/auth/login', adminLoginLimiter, (req, res, next) => {
  try {
    const { mobileNumber, pin, deviceInfo } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const result = AdminService.loginAdmin({
      mobileNumber,
      pin,
      deviceInfo,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Admin authenticated successfully',
      messageMr: 'प्रशासक लॉगिन यशस्वी झाले',
      data: {
        token: result.token,
        admin: result.user,
        user: result.user
      }
    });
  } catch (err) {
    next(err);
  }
});

// Admin Logout
adminRouter.post('/auth/logout', requireAdmin, (req: AuthenticatedRequest, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    AdminService.logAudit({
      adminUserId: req.user!.id,
      action: 'ADMIN_LOGOUT',
      targetAccountId: req.user!.id,
      targetMobileNumber: req.user!.mobile_number,
      ipAddress: ip
    });
  }
  res.json({
    success: true,
    message: 'Admin logged out successfully',
    messageMr: 'प्रशासक लॉगआउट यशस्वी झाले'
  });
});

// Admin Session Check
adminRouter.get('/auth/me', requireAdmin, (req: AuthenticatedRequest, res) => {
  res.json({
    success: true,
    data: {
      admin: req.user,
      user: req.user
    }
  });
});

// Admin Profile Update
adminRouter.patch('/profile', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const { fullName, preferredLanguage } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const updated = AdminService.updateAdminProfile({
      adminUserId: req.user!.id,
      fullName,
      preferredLanguage,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Admin profile updated successfully',
      messageMr: 'प्रशासक प्रोफाइल यशस्वीरित्या अपडेट केले',
      data: {
        admin: updated,
        user: updated
      }
    });
  } catch (err) {
    next(err);
  }
});

// Admin Change PIN
adminRouter.post('/auth/change-pin', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const { currentPin, newPin, confirmPin } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const result = AdminService.changeAdminPin({
      adminUserId: req.user!.id,
      currentPin,
      newPin,
      confirmPin,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Admin PIN changed successfully',
      messageMr: 'प्रशासक पिन यशस्वीरित्या बदलला गेला',
      data: {
        token: result.token,
        admin: result.user,
        user: result.user
      }
    });
  } catch (err) {
    next(err);
  }
});

// Accounts metadata list (NO grocery data)
adminRouter.get('/accounts', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
    const search = req.query.search ? String(req.query.search) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;

    const result = AdminService.getAccounts({ page, limit, search, status });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Recovery Requests queue
adminRouter.get('/recovery-requests', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
    const status = req.query.status ? String(req.query.status) : undefined;

    const result = AdminService.getRecoveryRequests({ page, limit, status });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Approve Recovery Request
adminRouter.post('/recovery-requests/:id/approve', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const requestId = req.params.id;
    const { verificationMethod, notes } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.approveRecoveryRequest({
      requestId,
      adminUserId: req.user!.id,
      verificationMethod,
      notes,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Recovery request approved successfully',
      messageMr: 'रिकव्हरी विनंती यशस्वीरित्या मंजूर केली',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Reject Recovery Request
adminRouter.post('/recovery-requests/:id/reject', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const requestId = req.params.id;
    const { reason } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    AdminService.rejectRecoveryRequest({
      requestId,
      adminUserId: req.user!.id,
      reason,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Recovery request rejected',
      messageMr: 'रिकव्हरी विनंती नाकारली आहे'
    });
  } catch (err) {
    next(err);
  }
});

// Permanent Account Deletion
adminRouter.post('/accounts/:id/delete', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const targetAccountId = req.params.id;
    const { confirmMobileNumber, confirmationPhrase } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = await AdminService.deleteAccount({
      adminUserId: req.user!.id,
      targetAccountId,
      confirmMobileNumber,
      confirmationPhrase,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Account deleted permanently',
      messageMr: 'खाते कायमस्वरूपी हटवले आहे',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Security & Audit Logs
adminRouter.get('/audit-logs', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const action = req.query.action ? String(req.query.action) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;

    const result = AdminService.getAuditLogs({ page, limit, action, search });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
});
