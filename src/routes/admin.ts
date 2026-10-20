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

// Permanent Single Recovery Request Deletion
adminRouter.post('/recovery-requests/:id/delete', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const requestId = req.params.id;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.deleteRecoveryRequest({
      requestId,
      adminUserId: req.user!.id,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Recovery request permanently deleted',
      messageMr: 'रिकव्हरी विनंती कायमस्वरूपी हटवली आहे',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/recovery-requests/:id', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const requestId = req.params.id;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.deleteRecoveryRequest({
      requestId,
      adminUserId: req.user!.id,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Recovery request permanently deleted',
      messageMr: 'रिकव्हरी विनंती कायमस्वरूपी हटवली आहे',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Permanent Bulk Recovery Requests Deletion
adminRouter.post('/recovery-requests/bulk-delete', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const { confirmationPhrase } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.bulkDeleteRecoveryRequests({
      adminUserId: req.user!.id,
      confirmationPhrase,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: `Permanently deleted ${result.deletedCount} recovery request(s)`,
      messageMr: `${result.deletedCount} रिकव्हरी विनंत्या कायमस्वरूपी हटवल्या आहेत`,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/recovery-requests', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const { confirmationPhrase } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.bulkDeleteRecoveryRequests({
      adminUserId: req.user!.id,
      confirmationPhrase,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: `Permanently deleted ${result.deletedCount} recovery request(s)`,
      messageMr: `${result.deletedCount} रिकव्हरी विनंत्या कायमस्वरूपी हटवल्या आहेत`,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Permanent Single Account Deletion
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

// Bulk Account Deletion (All Ordinary Non-Admin Users)
adminRouter.post('/accounts/bulk-delete', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { confirmationPhrase, expectedCount } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = await AdminService.bulkDeleteAccounts({
      adminUserId: req.user!.id,
      confirmationPhrase,
      expectedCount,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: `Successfully purged ${result.deletedCount} ordinary user account(s)`,
      messageMr: `${result.deletedCount} सामान्य वापरकर्ता खाती यशस्वीरित्या हटवली`,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Security & Audit Logs (Active view by default, archived optionally)
adminRouter.get('/audit-logs', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const action = req.query.action ? String(req.query.action) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const showArchived = req.query.showArchived === 'true' || req.query.archived === 'true';

    const result = AdminService.getAuditLogs({ page, limit, action, search, showArchived });
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Archive Single Audit Entry
adminRouter.post('/audit-logs/:id/archive', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const logId = req.params.id;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.archiveAuditLog({
      id: logId,
      adminUserId: req.user!.id,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Audit log entry archived from active view',
      messageMr: 'ऑडिट लॉग नोंद सक्रिय दृश्यातून संग्रहित केली',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Bulk Archive All Active Audit Entries
adminRouter.post('/audit-logs/archive-all', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const { confirmationPhrase } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.bulkArchiveAuditLogs({
      adminUserId: req.user!.id,
      confirmationPhrase,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: `Archived ${result.count} audit entry/entries from active view`,
      messageMr: `${result.count} ऑडिट नोंदी सक्रिय दृश्यातून संग्रहित केल्या`,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Permanent Single Archived Audit Log Deletion
adminRouter.post('/audit-logs/:id/delete', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const logId = req.params.id;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.deleteArchivedAuditLog({
      id: logId,
      adminUserId: req.user!.id,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Archived audit log entry permanently deleted',
      messageMr: 'संग्रहित ऑडिट लॉग नोंद कायमस्वरूपी हटवली आहे',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/audit-logs/:id', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const logId = req.params.id;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.deleteArchivedAuditLog({
      id: logId,
      adminUserId: req.user!.id,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: 'Archived audit log entry permanently deleted',
      messageMr: 'संग्रहित ऑडिट लॉग नोंद कायमस्वरूपी हटवली आहे',
      data: result
    });
  } catch (err) {
    next(err);
  }
});

// Permanent Bulk Archived Audit Logs Deletion
adminRouter.post('/audit-logs/bulk-delete-archived', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const { confirmationPhrase } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.bulkDeleteArchivedAuditLogs({
      adminUserId: req.user!.id,
      confirmationPhrase,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: `Permanently deleted ${result.count} archived audit log(s)`,
      messageMr: `${result.count} संग्रहित ऑडिट नोंदी कायमस्वरूपी हटवल्या आहेत`,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/audit-logs/archived', requireAdmin, (req: AuthenticatedRequest, res, next) => {
  try {
    const { confirmationPhrase } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const result = AdminService.bulkDeleteArchivedAuditLogs({
      adminUserId: req.user!.id,
      confirmationPhrase,
      ipAddress: ip
    });

    res.json({
      success: true,
      message: `Permanently deleted ${result.count} archived audit log(s)`,
      messageMr: `${result.count} संग्रहित ऑडिट नोंदी कायमस्वरूपी हटवल्या आहेत`,
      data: result
    });
  } catch (err) {
    next(err);
  }
});

