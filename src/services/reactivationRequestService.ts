import { getDatabase } from '../db/database.js';
import { generateId } from '../utils/crypto.js';
import { normalizeMobileNumber } from '../utils/validation.js';
import { AdminService } from './adminService.js';
import { TelegramService } from './telegramService.js';
import { SecurityService } from './securityService.js';
import type { ReactivationRequestRecord, User } from '../types/index.js';

export class ReactivationRequestService {
  /**
   * User submits a reactivation request from mobile app when locked.
   */
  static createRequest(params: {
    mobileNumber: string;
    reason?: string;
    ipAddress?: string;
  }): { request: ReactivationRequestRecord } {
    const normalizedMobile = normalizeMobileNumber(params.mobileNumber);
    if (!normalizedMobile) {
      const err: any = new Error('INVALID_MOBILE: Please enter a valid 10-digit mobile number');
      err.status = 400;
      err.code = 'INVALID_MOBILE';
      err.errorMr = 'कृपया वैध १०-अंकी मोबाईल नंबर प्रविष्ट करा';
      throw err;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;

    if (!user) {
      const err: any = new Error('USER_NOT_FOUND: No registered account found for this mobile number');
      err.status = 404;
      err.code = 'USER_NOT_FOUND';
      err.errorMr = 'या मोबाईल नंबरसाठी कोणतेही नोंदणीकृत खाते आढळले नाही';
      throw err;
    }

    // Check if account is actually locked
    const isLocked = Boolean(user.locked_until && new Date(user.locked_until).getTime() > Date.now());
    if (!isLocked) {
      const err: any = new Error('ACCOUNT_NOT_LOCKED: Account is not currently locked.');
      err.status = 400;
      err.code = 'ACCOUNT_NOT_LOCKED';
      err.errorMr = 'खाते सध्या लॉक केलेले नाही.';
      throw err;
    }

    // Check if there is already a PENDING request
    const pendingRequest = db.prepare(`
      SELECT id FROM reactivation_requests
      WHERE mobile_number = ? AND status = 'PENDING'
    `).get(normalizedMobile) as { id: string } | undefined;

    if (pendingRequest) {
      const err: any = new Error('DUPLICATE_REQUEST: A reactivation request is already pending review.');
      err.status = 409;
      err.code = 'DUPLICATE_REQUEST';
      err.errorMr = 'खाते पुन्हा सुरू करण्याची विनंती आधीच प्रलंबित आहे.';
      throw err;
    }

    const id = generateId();
    const nowIso = new Date().toISOString();
    const userReason = (params.reason || '').trim() || 'User requested account reactivation';

    db.prepare(`
      INSERT INTO reactivation_requests (
        id, user_id, mobile_number, reason, status, lock_type, lock_reason,
        failed_attempts_at_lock, admin_user_id, admin_notes, reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id,
      user.id,
      normalizedMobile,
      userReason,
      user.lock_type || 'AUTOMATIC',
      user.lock_reason || null,
      user.failed_login_attempts || 5,
      nowIso,
      nowIso
    );

    const createdRecord = db.prepare('SELECT * FROM reactivation_requests WHERE id = ?').get(id) as ReactivationRequestRecord;

    // Notify Telegram Admin asynchronously
    void TelegramService.notifyReactivationRequest({
      requestId: id,
      mobileNumber: normalizedMobile,
      fullName: user.full_name || null,
      reason: userReason,
      lockType: user.lock_type,
      failedAttempts: user.failed_login_attempts,
      createdAt: nowIso
    }).catch(err => console.warn('[ReactivationRequestService] Telegram notification notice:', err?.message));

    return { request: createdRecord };
  }

  /**
   * Check latest reactivation request status for a mobile number.
   */
  static getRequestStatus(params: {
    mobileNumber: string;
    requestId?: string;
  }): { hasRequest: boolean; request: ReactivationRequestRecord | null } {
    const normalizedMobile = normalizeMobileNumber(params.mobileNumber);
    if (!normalizedMobile) {
      const err: any = new Error('INVALID_MOBILE: Please enter a valid 10-digit mobile number');
      err.status = 400;
      err.code = 'INVALID_MOBILE';
      err.errorMr = 'कृपया वैध १०-अंकी मोबाईल नंबर प्रविष्ट करा';
      throw err;
    }

    const db = getDatabase();
    let query = 'SELECT * FROM reactivation_requests WHERE mobile_number = ?';
    const queryParams: any[] = [normalizedMobile];

    if (params.requestId) {
      query += ' AND id = ?';
      queryParams.push(params.requestId);
    }

    query += ' ORDER BY created_at DESC LIMIT 1';

    const request = db.prepare(query).get(...queryParams) as ReactivationRequestRecord | undefined;

    if (!request) {
      return { hasRequest: false, request: null };
    }

    return { hasRequest: true, request };
  }

  /**
   * Admin: List reactivation requests with user metadata.
   */
  static getReactivationRequests(params: {
    status?: string;
    page?: number;
    limit?: number;
  }): {
    requests: Array<ReactivationRequestRecord & { user_full_name: string }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  } {
    const db = getDatabase();
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const whereArgs: any[] = [];

    if (params.status && params.status !== 'ALL') {
      whereClause += ' AND r.status = ?';
      whereArgs.push(params.status.toUpperCase());
    }

    const countRow = db.prepare(`
      SELECT COUNT(*) as count FROM reactivation_requests r WHERE ${whereClause}
    `).get(...whereArgs) as { count: number };

    const total = countRow ? countRow.count : 0;
    const totalPages = Math.ceil(total / limit) || 1;

    const rows = db.prepare(`
      SELECT 
        r.*,
        COALESCE(u.full_name, 'Unknown User') as user_full_name
      FROM reactivation_requests r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...whereArgs, limit, offset) as Array<ReactivationRequestRecord & { user_full_name: string }>;

    return {
      requests: rows,
      total,
      page,
      limit,
      totalPages
    };
  }

  /**
   * Admin: Approve reactivation request and unlock account.
   */
  static approveRequest(params: {
    requestId: string;
    adminUserId: string;
    notes?: string;
    ipAddress?: string;
  }): { success: boolean; request: ReactivationRequestRecord } {
    const db = getDatabase();
    const request = db.prepare('SELECT * FROM reactivation_requests WHERE id = ?').get(params.requestId) as ReactivationRequestRecord | undefined;

    if (!request) {
      const err: any = new Error('REQUEST_NOT_FOUND: Reactivation request not found');
      err.status = 404;
      err.code = 'REQUEST_NOT_FOUND';
      err.errorMr = 'पुन्हा सक्रिय करण्याची विनंती आढळली नाही';
      throw err;
    }

    if (request.status !== 'PENDING') {
      const err: any = new Error(`REQUEST_ALREADY_PROCESSED: Request is already ${request.status}`);
      err.status = 409;
      err.code = 'REQUEST_ALREADY_PROCESSED';
      err.errorMr = `विनंती आधीच प्रक्रिया झाली आहे (${request.status})`;
      throw err;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ? OR mobile_number = ?').get(request.user_id, request.mobile_number) as User | undefined;
    const nowIso = new Date().toISOString();
    const adminNotes = (params.notes || '').trim() || 'Approved by administrator';

    db.transaction(() => {
      // 1. Mark request as APPROVED (optimistic concurrency lock on PENDING status)
      const updateReq = db.prepare(`
        UPDATE reactivation_requests
        SET status = 'APPROVED',
            admin_user_id = ?,
            admin_notes = ?,
            reviewed_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(params.adminUserId, adminNotes, nowIso, nowIso, request.id);

      if (updateReq.changes === 0) {
        const current = db.prepare('SELECT status FROM reactivation_requests WHERE id = ?').get(request.id) as { status: string } | undefined;
        const err: any = new Error(`REQUEST_ALREADY_PROCESSED: Request is already ${current?.status || 'PROCESSED'}`);
        err.status = 409;
        err.code = 'REQUEST_ALREADY_PROCESSED';
        err.errorMr = `विनंती आधीच प्रक्रिया झाली आहे (${current?.status || 'PROCESSED'})`;
        throw err;
      }

      // 2. Unlock the user account and reset failures
      if (user) {
        db.prepare(`
          UPDATE users
          SET locked_until = NULL,
              failed_login_attempts = 0,
              lock_type = NULL,
              lock_reason = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(nowIso, user.id);

        SecurityService.clearRevokedTokensForUser(user.id);
      }
    })();

    // 3. Log admin audit
    AdminService.logAudit({
      adminUserId: params.adminUserId,
      action: 'REACTIVATION_REQUEST_APPROVED',
      targetAccountId: request.user_id,
      targetMobileNumber: request.mobile_number,
      details: {
        requestId: request.id,
        notes: adminNotes
      },
      ipAddress: params.ipAddress
    });

    // Notify Telegram Admin asynchronously
    void TelegramService.notifyAdminDecision({
      type: 'REACTIVATION',
      decision: 'APPROVED',
      requestId: request.id,
      targetMobileNumber: request.mobile_number,
      targetFullName: user?.full_name || null,
      adminNotes: adminNotes,
      timestamp: nowIso
    }).catch(err => console.warn('[ReactivationRequestService] Telegram decision notice:', err?.message));

    const updatedRequest = db.prepare('SELECT * FROM reactivation_requests WHERE id = ?').get(request.id) as ReactivationRequestRecord;
    return { success: true, request: updatedRequest };
  }

  /**
   * Admin: Reject reactivation request.
   */
  static rejectRequest(params: {
    requestId: string;
    adminUserId: string;
    reason?: string;
    ipAddress?: string;
  }): { success: boolean; request: ReactivationRequestRecord } {
    const db = getDatabase();
    const request = db.prepare('SELECT * FROM reactivation_requests WHERE id = ?').get(params.requestId) as ReactivationRequestRecord | undefined;

    if (!request) {
      const err: any = new Error('REQUEST_NOT_FOUND: Reactivation request not found');
      err.status = 404;
      err.code = 'REQUEST_NOT_FOUND';
      err.errorMr = 'पुन्हा सक्रिय करण्याची विनंती आढळली नाही';
      throw err;
    }

    if (request.status !== 'PENDING') {
      const err: any = new Error(`REQUEST_ALREADY_PROCESSED: Request is already ${request.status}`);
      err.status = 409;
      err.code = 'REQUEST_ALREADY_PROCESSED';
      err.errorMr = `विनंती आधीच प्रक्रिया झाली आहे (${request.status})`;
      throw err;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ? OR mobile_number = ?').get(request.user_id, request.mobile_number) as User | undefined;
    const rejectionReason = (params.reason || '').trim() || 'Rejected by administrator';
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      const updateReq = db.prepare(`
        UPDATE reactivation_requests
        SET status = 'REJECTED',
            admin_user_id = ?,
            admin_notes = ?,
            reviewed_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(params.adminUserId, rejectionReason, nowIso, nowIso, request.id);

      if (updateReq.changes === 0) {
        const current = db.prepare('SELECT status FROM reactivation_requests WHERE id = ?').get(request.id) as { status: string } | undefined;
        const err: any = new Error(`REQUEST_ALREADY_PROCESSED: Request is already ${current?.status || 'PROCESSED'}`);
        err.status = 409;
        err.code = 'REQUEST_ALREADY_PROCESSED';
        err.errorMr = `विनंती आधीच प्रक्रिया झाली आहे (${current?.status || 'PROCESSED'})`;
        throw err;
      }
      // Note: User account remains locked as per policy
    })();

    // Log admin audit
    AdminService.logAudit({
      adminUserId: params.adminUserId,
      action: 'REACTIVATION_REQUEST_REJECTED',
      targetAccountId: request.user_id,
      targetMobileNumber: request.mobile_number,
      details: {
        requestId: request.id,
        reason: rejectionReason
      },
      ipAddress: params.ipAddress
    });

    // Notify Telegram Admin asynchronously
    void TelegramService.notifyAdminDecision({
      type: 'REACTIVATION',
      decision: 'REJECTED',
      requestId: request.id,
      targetMobileNumber: request.mobile_number,
      targetFullName: user?.full_name || null,
      adminNotes: rejectionReason,
      timestamp: nowIso
    }).catch(err => console.warn('[ReactivationRequestService] Telegram rejection notice:', err?.message));

    const updatedRequest = db.prepare('SELECT * FROM reactivation_requests WHERE id = ?').get(request.id) as ReactivationRequestRecord;
    return { success: true, request: updatedRequest };
  }
}
