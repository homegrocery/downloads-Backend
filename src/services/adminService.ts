import crypto from 'node:crypto';
import fs from 'node:fs';
import { getDatabase } from '../db/database.js';
import { config } from '../config.js';
import {
  hashPin,
  verifyPin,
  generateSessionToken,
  hashToken,
  generateId,
  generateRecoveryCode,
  hashRecoveryCode,
  encryptTemporaryCode,
  decryptTemporaryCode
} from '../utils/crypto.js';
import { normalizeMobileNumber, validatePin } from '../utils/validation.js';
import type { User, SafeUser, RecoveryRequestRecord, AdminAuditLogRecord } from '../types/index.js';
import { getAdminFirestore } from './firebaseAdmin.js';

export class AdminService {
  /**
   * Log an administrative action to admin_audit_logs.
   * Plaintext PINs, recovery codes and session tokens are strictly excluded.
   */
  static logAudit(params: {
    adminUserId: string;
    action: string;
    targetAccountId?: string | null;
    targetMobileNumber?: string | null;
    details?: Record<string, any> | null;
    ipAddress?: string | null;
  }): void {
    try {
      const db = getDatabase();
      const id = generateId();
      const nowIso = new Date().toISOString();
      const detailsStr = params.details ? JSON.stringify(params.details) : null;

      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_user_id, action, target_account_id, target_mobile_number, details, ip_address, is_archived, archived_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      `).run(
        id,
        params.adminUserId,
        params.action,
        params.targetAccountId || null,
        params.targetMobileNumber || null,
        detailsStr,
        params.ipAddress || null,
        nowIso
      );
    } catch (e: any) {
      console.error('[AdminService] Failed to record audit log:', e.message);
    }
  }

  /**
   * Admin Login: Authenticates owner admin with mobile and PIN.
   * Enforces server-side authorization check (role === 'admin').
   */
  static loginAdmin(params: {
    mobileNumber: string;
    pin: string;
    deviceInfo?: string;
    ipAddress?: string;
  }): { user: SafeUser; token: string } {
    const normalizedMobile = normalizeMobileNumber(params.mobileNumber);
    if (!normalizedMobile) {
      const err: any = new Error('INVALID_MOBILE: Please enter a valid 10-digit mobile number');
      err.status = 400;
      err.code = 'INVALID_MOBILE';
      err.errorMr = 'कृपया वैध १०-अंकी मोबाईल नंबर प्रविष्ट करा';
      throw err;
    }

    if (!params.pin || typeof params.pin !== 'string') {
      const err: any = new Error('INVALID_PIN: PIN is required');
      err.status = 400;
      err.code = 'INVALID_PIN';
      err.errorMr = 'पिन आवश्यक आहे';
      throw err;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;

    if (!user) {
      this.logAudit({
        adminUserId: 'UNAUTHENTICATED',
        action: 'ADMIN_LOGIN_FAILED_NOT_FOUND',
        targetMobileNumber: normalizedMobile,
        ipAddress: params.ipAddress
      });
      const err: any = new Error('INVALID_CREDENTIALS: Admin authentication failed');
      err.status = 401;
      err.code = 'INVALID_CREDENTIALS';
      err.errorMr = 'प्रशासक लॉगिन अयशस्वी';
      throw err;
    }

    // Check account lockout
    const now = Date.now();
    if (user.locked_until) {
      const lockExpiry = new Date(user.locked_until).getTime();
      if (lockExpiry > now) {
        const remainingMinutes = Math.ceil((lockExpiry - now) / 60000);
        this.logAudit({
          adminUserId: user.id,
          action: 'ADMIN_LOGIN_LOCKED',
          targetAccountId: user.id,
          targetMobileNumber: user.mobile_number,
          ipAddress: params.ipAddress
        });
        const err: any = new Error(`ACCOUNT_LOCKED: Account is locked. Try again in ${remainingMinutes} minutes.`);
        err.status = 423;
        err.code = 'ACCOUNT_LOCKED';
        err.errorMr = `खाते लॉक आहे. कृपया ${remainingMinutes} मिनिटांनी प्रयत्न करा.`;
        throw err;
      }
    }

    // Verify PIN
    const isValidPin = verifyPin(params.pin, user.salt, user.pin_hash);
    if (!isValidPin) {
      const newAttempts = user.failed_login_attempts + 1;
      let lockedUntil: string | null = null;
      if (newAttempts >= config.maxFailedAttempts) {
        lockedUntil = new Date(now + config.lockoutMinutes * 60 * 1000).toISOString();
      }

      db.prepare(`
        UPDATE users
        SET failed_login_attempts = ?, locked_until = ?, updated_at = ?
        WHERE id = ?
      `).run(newAttempts, lockedUntil, new Date(now).toISOString(), user.id);

      this.logAudit({
        adminUserId: user.id,
        action: 'ADMIN_LOGIN_FAILED_WRONG_PIN',
        targetAccountId: user.id,
        targetMobileNumber: user.mobile_number,
        ipAddress: params.ipAddress
      });

      const err: any = new Error('INVALID_CREDENTIALS: Admin authentication failed');
      err.status = 401;
      err.code = 'INVALID_CREDENTIALS';
      err.errorMr = 'प्रशासक लॉगिन अयशस्वी';
      throw err;
    }

    // Strict Role Enforcement: must have role === 'admin'
    if (user.role !== 'admin') {
      this.logAudit({
        adminUserId: user.id,
        action: 'UNAUTHORIZED_ADMIN_ACCESS_ATTEMPT',
        targetAccountId: user.id,
        targetMobileNumber: user.mobile_number,
        details: { userRole: user.role },
        ipAddress: params.ipAddress
      });

      const err: any = new Error('ADMIN_FORBIDDEN: Access denied. This account does not possess administrator privileges.');
      err.status = 403;
      err.code = 'ADMIN_FORBIDDEN';
      err.errorMr = 'प्रवेश नाकारला. या खात्याकडे प्रशासक विशेषाधिकार उपलब्ध नाहीत.';
      throw err;
    }

    // Reset failed attempts on success
    db.prepare(`
      UPDATE users
      SET failed_login_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?
    `).run(new Date(now).toISOString(), user.id);

    // Create admin session
    const { rawToken, tokenHash } = generateSessionToken();
    const sessionId = generateId();
    const expiresAt = new Date(now + config.sessionTtlHours * 3600 * 1000).toISOString();

    db.prepare(`
      INSERT INTO authentication_sessions (
        id, user_id, token_hash, device_info, expires_at, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, user.id, tokenHash, params.deviceInfo || 'Admin ERP Web', expiresAt, new Date(now).toISOString(), new Date(now).toISOString());

    this.logAudit({
      adminUserId: user.id,
      action: 'ADMIN_LOGIN_SUCCESS',
      targetAccountId: user.id,
      targetMobileNumber: user.mobile_number,
      ipAddress: params.ipAddress
    });

    const safeUser: SafeUser = {
      id: user.id,
      mobile_number: user.mobile_number,
      full_name: user.full_name,
      preferred_language: user.preferred_language,
      failed_login_attempts: 0,
      locked_until: null,
      pin_length: user.pin_length || 6,
      role: 'admin',
      created_at: user.created_at,
      updated_at: user.updated_at
    };

    return { user: safeUser, token: rawToken };
  }

  /**
   * Update Owner Admin Profile (full_name, preferred_language).
   * Changing authorization role or mobile number is strictly prohibited.
   */
  static updateAdminProfile(params: {
    adminUserId: string;
    fullName?: string;
    preferredLanguage?: 'en' | 'mr';
    ipAddress?: string;
  }): SafeUser {
    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.adminUserId) as User | undefined;

    if (!user || user.role !== 'admin') {
      const err: any = new Error('ADMIN_FORBIDDEN: Access denied. Administrator privileges required.');
      err.status = 403;
      err.code = 'ADMIN_FORBIDDEN';
      err.errorMr = 'प्रवेश नाकारला. प्रशासक विशेषाधिकार आवश्यक आहेत.';
      throw err;
    }

    const updates: string[] = [];
    const args: any[] = [];
    const auditFields: string[] = [];

    if (params.fullName !== undefined) {
      const cleanName = params.fullName.trim();
      if (!cleanName || cleanName.length < 2) {
        const err: any = new Error('INVALID_NAME: Full name must be at least 2 characters');
        err.status = 400;
        err.code = 'INVALID_NAME';
        err.errorMr = 'पूर्ण नाव किमान २ अक्षरांचे असणे आवश्यक आहे';
        throw err;
      }
      updates.push('full_name = ?');
      args.push(cleanName);
      auditFields.push('full_name');
    }

    if (params.preferredLanguage !== undefined) {
      if (params.preferredLanguage !== 'en' && params.preferredLanguage !== 'mr') {
        const err: any = new Error('INVALID_LANGUAGE: Language must be "en" or "mr"');
        err.status = 400;
        err.code = 'INVALID_LANGUAGE';
        err.errorMr = 'भाषा "en" किंवा "mr" असणे आवश्यक आहे';
        throw err;
      }
      updates.push('preferred_language = ?');
      args.push(params.preferredLanguage);
      auditFields.push('preferred_language');
    }

    if (updates.length > 0) {
      const nowIso = new Date().toISOString();
      updates.push('updated_at = ?');
      args.push(nowIso);
      args.push(user.id);

      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...args);

      this.logAudit({
        adminUserId: user.id,
        action: 'ADMIN_PROFILE_UPDATED',
        targetAccountId: user.id,
        targetMobileNumber: user.mobile_number,
        details: { updatedFields: auditFields },
        ipAddress: params.ipAddress
      });
    }

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as User;
    return {
      id: updatedUser.id,
      mobile_number: updatedUser.mobile_number,
      full_name: updatedUser.full_name,
      preferred_language: updatedUser.preferred_language,
      failed_login_attempts: updatedUser.failed_login_attempts,
      locked_until: updatedUser.locked_until,
      pin_length: updatedUser.pin_length || 6,
      role: 'admin',
      created_at: updatedUser.created_at,
      updated_at: updatedUser.updated_at
    };
  }

  /**
   * Change Owner Admin PIN.
   * Verifies current PIN, enforces format, computes scrypt hash with fresh salt,
   * invalidates old sessions, generates new session token, and records audit event.
   */
  static changeAdminPin(params: {
    adminUserId: string;
    currentPin: string;
    newPin: string;
    confirmPin: string;
    ipAddress?: string;
  }): { success: boolean; token: string; user: SafeUser } {
    if (!params.currentPin || typeof params.currentPin !== 'string') {
      const err: any = new Error('INVALID_CURRENT_PIN: Current PIN is required');
      err.status = 400;
      err.code = 'INVALID_CURRENT_PIN';
      err.errorMr = 'चालू पिन आवश्यक आहे';
      throw err;
    }

    // Enforce 6-digit PIN format for owner
    if (!/^\d{4}$|^\d{6}$/.test(params.newPin)) {
      const err: any = new Error('INVALID_PIN_FORMAT: PIN must be 4 or 6 numeric digits');
      err.status = 400;
      err.code = 'INVALID_PIN_FORMAT';
      err.errorMr = 'पिन ४ किंवा ६ अंकांचा असणे आवश्यक आहे';
      throw err;
    }

    if (params.newPin !== params.confirmPin) {
      const err: any = new Error('PIN_MISMATCH: New PIN and confirmation do not match');
      err.status = 400;
      err.code = 'PIN_MISMATCH';
      err.errorMr = 'नवीन पिन आणि पुष्टीकरण जुळत नाही';
      throw err;
    }

    if (params.currentPin === params.newPin) {
      const err: any = new Error('PIN_IDENTICAL: New PIN must be different from current PIN');
      err.status = 400;
      err.code = 'PIN_IDENTICAL';
      err.errorMr = 'नवीन पिन चालू पिनपेक्षा वेगळा असावा';
      throw err;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.adminUserId) as User | undefined;

    if (!user || user.role !== 'admin') {
      const err: any = new Error('ADMIN_FORBIDDEN: Access denied. Administrator privileges required.');
      err.status = 403;
      err.code = 'ADMIN_FORBIDDEN';
      err.errorMr = 'प्रवेश नाकारला. प्रशासक विशेषाधिकार आवश्यक आहेत.';
      throw err;
    }

    // Verify current PIN
    const isValidCurrent = verifyPin(params.currentPin, user.salt, user.pin_hash);
    if (!isValidCurrent) {
      this.logAudit({
        adminUserId: user.id,
        action: 'ADMIN_PIN_CHANGE_FAILED_WRONG_PIN',
        targetAccountId: user.id,
        targetMobileNumber: user.mobile_number,
        ipAddress: params.ipAddress
      });

      const err: any = new Error('INVALID_CURRENT_PIN: Current PIN is incorrect');
      err.status = 401;
      err.code = 'INVALID_CURRENT_PIN';
      err.errorMr = 'चालू पिन चुकीचा आहे';
      throw err;
    }

    // Hash new PIN with fresh cryptographic salt
    const newPinLength = params.newPin.length;
    const { hash, salt } = hashPin(params.newPin);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Generate fresh session token for the owner
    const { rawToken, tokenHash } = generateSessionToken();
    const sessionId = generateId();
    const expiresAt = new Date(now + config.sessionTtlHours * 3600 * 1000).toISOString();

    db.transaction(() => {
      // Update PIN
      db.prepare(`
        UPDATE users
        SET pin_hash = ?,
            salt = ?,
            pin_length = ?,
            failed_login_attempts = 0,
            locked_until = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(hash, salt, newPinLength, nowIso, user.id);

      // Invalidate old sessions and create a fresh session
      db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(user.id);
      db.prepare(`
        INSERT INTO authentication_sessions (
          id, user_id, token_hash, device_info, expires_at, created_at, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, user.id, tokenHash, 'Admin ERP Web (PIN Changed)', expiresAt, nowIso, nowIso);
    })();

    this.logAudit({
      adminUserId: user.id,
      action: 'ADMIN_PIN_CHANGED',
      targetAccountId: user.id,
      targetMobileNumber: user.mobile_number,
      details: { method: 'admin_erp_portal', pinLength: newPinLength },
      ipAddress: params.ipAddress
    });

    const safeUser: SafeUser = {
      id: user.id,
      mobile_number: user.mobile_number,
      full_name: user.full_name,
      preferred_language: user.preferred_language,
      failed_login_attempts: 0,
      locked_until: null,
      pin_length: newPinLength,
      role: 'admin',
      created_at: user.created_at,
      updated_at: nowIso
    };

    return { success: true, token: rawToken, user: safeUser };
  }

  /**
   * Get Accounts metadata. Excludes plaintext PINs, hashes, sessions, grocery lists and items.
   */
  static getAccounts(params: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): {
    accounts: Array<{
      id: string;
      mobile_number: string;
      full_name: string;
      preferred_language: string;
      pin_length: number;
      role: 'user' | 'admin';
      created_at: string;
      updated_at: string;
      failed_login_attempts: number;
      locked_until: string | null;
      is_locked: boolean;
      has_recovery_code: boolean;
      recovery_locked_until: string | null;
      pending_recovery_request_id: string | null;
      pending_recovery_status: string | null;
    }>;
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

    if (params.search && params.search.trim()) {
      const q = `%${params.search.trim()}%`;
      whereClause += ' AND (u.mobile_number LIKE ? OR u.full_name LIKE ? OR u.id LIKE ?)';
      whereArgs.push(q, q, q);
    }

    const countRow = db.prepare(`
      SELECT COUNT(*) as count FROM users u WHERE ${whereClause}
    `).get(...whereArgs) as { count: number };

    const total = countRow ? countRow.count : 0;
    const totalPages = Math.ceil(total / limit) || 1;

    const rows = db.prepare(`
      SELECT 
        u.id,
        u.mobile_number,
        u.full_name,
        u.preferred_language,
        u.pin_length,
        u.role,
        u.created_at,
        u.updated_at,
        u.failed_login_attempts,
        u.locked_until,
        (
          SELECT rc.locked_until 
          FROM recovery_codes rc 
          WHERE rc.user_id = u.id AND rc.status = 'ACTIVE' 
          LIMIT 1
        ) as recovery_locked_until,
        (
          SELECT COUNT(*) 
          FROM recovery_codes rc 
          WHERE rc.user_id = u.id AND rc.status = 'ACTIVE'
        ) as active_recovery_count,
        (
          SELECT rr.id 
          FROM recovery_requests rr 
          WHERE (rr.user_id = u.id OR rr.mobile_number = u.mobile_number) AND rr.status IN ('PENDING', 'APPROVED')
          ORDER BY rr.created_at DESC 
          LIMIT 1
        ) as pending_recovery_request_id,
        (
          SELECT rr.status 
          FROM recovery_requests rr 
          WHERE (rr.user_id = u.id OR rr.mobile_number = u.mobile_number) AND rr.status IN ('PENDING', 'APPROVED')
          ORDER BY rr.created_at DESC 
          LIMIT 1
        ) as pending_recovery_status
      FROM users u
      WHERE ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...whereArgs, limit, offset) as any[];

    const now = Date.now();
    const accounts = rows.map(r => ({
      id: r.id,
      mobile_number: r.mobile_number,
      full_name: r.full_name,
      preferred_language: r.preferred_language,
      pin_length: r.pin_length || 6,
      role: (r.role || 'user') as 'user' | 'admin',
      created_at: r.created_at,
      updated_at: r.updated_at,
      failed_login_attempts: r.failed_login_attempts,
      locked_until: r.locked_until,
      is_locked: Boolean(r.locked_until && new Date(r.locked_until).getTime() > now),
      has_recovery_code: Number(r.active_recovery_count) > 0,
      recovery_locked_until: r.recovery_locked_until,
      pending_recovery_request_id: r.pending_recovery_request_id || null,
      pending_recovery_status: r.pending_recovery_status || null
    }));

    return {
      accounts,
      total,
      page,
      limit,
      totalPages
    };
  }

  /**
   * Get Recovery Requests queue.
   */
  static getRecoveryRequests(params: {
    page?: number;
    limit?: number;
    status?: string;
  }): {
    requests: Array<any>;
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

    if (params.status && params.status.trim() && params.status !== 'ALL') {
      whereClause += ' AND rr.status = ?';
      whereArgs.push(params.status.trim());
    }

    const countRow = db.prepare(`
      SELECT COUNT(*) as count FROM recovery_requests rr WHERE ${whereClause}
    `).get(...whereArgs) as { count: number };

    const total = countRow ? countRow.count : 0;
    const totalPages = Math.ceil(total / limit) || 1;

    const rows = db.prepare(`
      SELECT 
        rr.*,
        u.full_name as user_full_name,
        u.pin_length as user_pin_length,
        (
          SELECT rc.locked_until 
          FROM recovery_codes rc 
          WHERE rc.user_id = rr.user_id AND rc.status = 'ACTIVE' 
          LIMIT 1
        ) as prior_recovery_lockout
      FROM recovery_requests rr
      LEFT JOIN users u ON rr.user_id = u.id
      WHERE ${whereClause}
      ORDER BY 
        CASE rr.status 
          WHEN 'PENDING' THEN 1 
          WHEN 'APPROVED' THEN 2 
          ELSE 3 
        END,
        rr.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...whereArgs, limit, offset) as any[];

    const now = Date.now();
    const requests = rows.map(r => {
      let approvedCode: string | null = null;
      // If approved and not expired, authorized admin can view/copy the temporary code
      if (r.status === 'APPROVED' && r.approved_code_encrypted && r.approved_code_iv && r.approved_code_tag) {
        if (new Date(r.expires_at).getTime() > now) {
          try {
            approvedCode = decryptTemporaryCode(r.approved_code_encrypted, r.approved_code_iv, r.approved_code_tag);
          } catch {
            approvedCode = null;
          }
        }
      }

      return {
        id: r.id,
        user_id: r.user_id,
        mobile_number: r.mobile_number,
        user_full_name: r.user_full_name || 'Unregistered / Unknown',
        user_pin_length: r.user_pin_length || 6,
        status: r.status,
        verification_method: r.verification_method,
        verification_notes: r.verification_notes,
        approved_code: approvedCode,
        failed_attempts: r.failed_attempts,
        locked_until: r.locked_until,
        prior_recovery_lockout: r.prior_recovery_lockout,
        expires_at: r.expires_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
        completed_at: r.completed_at
      };
    });

    return {
      requests,
      total,
      page,
      limit,
      totalPages
    };
  }

  /**
   * Approve a recovery request: Requires independent verification method.
   * Generates a 30-minute encrypted temporary recovery code.
   */
  static approveRecoveryRequest(params: {
    requestId: string;
    adminUserId: string;
    verificationMethod: string;
    notes?: string;
    ipAddress?: string;
  }): { success: boolean; temporaryCode: string; expiresAt: string } {
    if (!params.verificationMethod || !params.verificationMethod.trim()) {
      const err: any = new Error('VERIFICATION_REQUIRED: Independent identity verification method is required before approval');
      err.status = 400;
      err.code = 'VERIFICATION_REQUIRED';
      err.errorMr = 'मंजुरी देण्यापूर्वी स्वतंत्र ओळख पडताळणी पद्धत निवडणे आवश्यक आहे';
      throw err;
    }

    const db = getDatabase();
    const reqRecord = db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(params.requestId) as RecoveryRequestRecord | undefined;

    if (!reqRecord) {
      const err: any = new Error('REQUEST_NOT_FOUND: Recovery request does not exist');
      err.status = 404;
      err.code = 'REQUEST_NOT_FOUND';
      err.errorMr = 'रिकव्हरी विनंती आढळली नाही';
      throw err;
    }

    if (reqRecord.status !== 'PENDING') {
      const err: any = new Error(`INVALID_STATUS: Request is already ${reqRecord.status.toLowerCase()}`);
      err.status = 400;
      err.code = 'INVALID_STATUS';
      err.errorMr = `विनंती आधीच ${reqRecord.status} आहे`;
      throw err;
    }

    // Generate fresh high-entropy code
    const tempCode = generateRecoveryCode();
    const { encrypted, iv, tag } = encryptTemporaryCode(tempCode);
    const { hash: codeHash, salt: codeSalt } = hashRecoveryCode(tempCode);
    const tempCodeId = generateId();

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresIso = new Date(now + config.recoveryTempCodeTtlMinutes * 60 * 1000).toISOString();

    db.transaction(() => {
      if (reqRecord.user_id) {
        // Insert temporary code in recovery_codes without touching ACTIVE permanent code
        db.prepare(`
          INSERT INTO recovery_codes (
            id, user_id, code_hash, salt, status, failed_attempts, locked_until, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'TEMPORARY', 0, NULL, ?, ?)
        `).run(tempCodeId, reqRecord.user_id, codeHash, codeSalt, nowIso, nowIso);
      }

      db.prepare(`
        UPDATE recovery_requests
        SET 
          status = 'APPROVED',
          verification_method = ?,
          verification_notes = ?,
          approved_code_encrypted = ?,
          approved_code_iv = ?,
          approved_code_tag = ?,
          approved_code_hash = ?,
          approved_code_salt = ?,
          failed_attempts = 0,
          locked_until = NULL,
          expires_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        params.verificationMethod.trim(),
        params.notes?.trim() || null,
        encrypted,
        iv,
        tag,
        codeHash,
        codeSalt,
        expiresIso,
        nowIso,
        reqRecord.id
      );
    })();

    this.logAudit({
      adminUserId: params.adminUserId,
      action: 'RECOVERY_REQUEST_APPROVED',
      targetAccountId: reqRecord.user_id,
      targetMobileNumber: reqRecord.mobile_number,
      details: {
        requestId: reqRecord.id,
        verificationMethod: params.verificationMethod.trim(),
        expiresAt: expiresIso,
        ttlMinutes: config.recoveryTempCodeTtlMinutes
      },
      ipAddress: params.ipAddress
    });

    return {
      success: true,
      temporaryCode: tempCode,
      expiresAt: expiresIso
    };
  }

  /**
   * Reject a recovery request with reason.
   */
  static rejectRecoveryRequest(params: {
    requestId: string;
    adminUserId: string;
    reason: string;
    ipAddress?: string;
  }): boolean {
    const db = getDatabase();
    const reqRecord = db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(params.requestId) as RecoveryRequestRecord | undefined;

    if (!reqRecord) {
      const err: any = new Error('REQUEST_NOT_FOUND: Recovery request does not exist');
      err.status = 404;
      err.code = 'REQUEST_NOT_FOUND';
      err.errorMr = 'रिकव्हरी विनंती आढळली नाही';
      throw err;
    }

    if (reqRecord.status !== 'PENDING') {
      const err: any = new Error(`INVALID_STATUS: Request is already ${reqRecord.status.toLowerCase()}`);
      err.status = 400;
      err.code = 'INVALID_STATUS';
      err.errorMr = `विनंती आधीच ${reqRecord.status} आहे`;
      throw err;
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE recovery_requests
      SET 
        status = 'REJECTED',
        verification_notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(params.reason?.trim() || 'Rejected by administrator', nowIso, reqRecord.id);

    this.logAudit({
      adminUserId: params.adminUserId,
      action: 'RECOVERY_REQUEST_REJECTED',
      targetAccountId: reqRecord.user_id,
      targetMobileNumber: reqRecord.mobile_number,
      details: {
        requestId: reqRecord.id,
        reason: params.reason?.trim()
      },
      ipAddress: params.ipAddress
    });

    return true;
  }

  /**
   * Permanent Account Deletion across SQLite and Firestore.
   * Requires exact confirmation of mobile number and confirmation phrase ("DELETE").
   */
  static async deleteAccount(params: {
    adminUserId: string;
    targetAccountId: string;
    confirmMobileNumber: string;
    confirmationPhrase: string;
    ipAddress?: string;
  }): Promise<{
    success: boolean;
    deletedAccountId: string;
    deletedAt: string;
    sqliteDeleted: boolean;
    firestoreDeleted: boolean;
    firestoreMessage?: string;
  }> {
    if (!params.confirmationPhrase || params.confirmationPhrase.trim().toUpperCase() !== 'DELETE') {
      const err: any = new Error('CONFIRMATION_MISMATCH: Confirmation phrase must be DELETE');
      err.status = 400;
      err.code = 'CONFIRMATION_MISMATCH';
      err.errorMr = 'खात्री शब्द DELETE असणे आवश्यक आहे';
      throw err;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.targetAccountId) as User | undefined;

    if (!user) {
      const err: any = new Error('USER_NOT_FOUND: Account does not exist');
      err.status = 404;
      err.code = 'USER_NOT_FOUND';
      err.errorMr = 'खाते आढळले नाही';
      throw err;
    }

    // Safety: Cannot delete oneself or any administrator or designated owner
    if (user.id === params.adminUserId) {
      const err: any = new Error('CANNOT_DELETE_SELF: Administrators cannot delete their own active account');
      err.status = 400;
      err.code = 'CANNOT_DELETE_SELF';
      err.errorMr = 'प्रशासक स्वतःचे खाते हटवू शकत नाहीत';
      throw err;
    }

    if (user.role === 'admin' || user.mobile_number === '9356755100' || user.mobile_number === config.adminMobileNumber) {
      const err: any = new Error('CANNOT_DELETE_ADMIN: Administrator and owner accounts are strictly protected from deletion');
      err.status = 400;
      err.code = 'CANNOT_DELETE_ADMIN';
      err.errorMr = 'प्रशासक आणि मालक खाती सुरक्षित आहेत आणि हटवता येत नाहीत';
      throw err;
    }

    const normalizedConfirm = normalizeMobileNumber(params.confirmMobileNumber);
    if (normalizedConfirm !== user.mobile_number) {
      const err: any = new Error('MOBILE_MISMATCH: Confirmation mobile number does not match account mobile number');
      err.status = 400;
      err.code = 'MOBILE_MISMATCH';
      err.errorMr = 'खात्री मोबाईल नंबर खात्याच्या मोबाईल नंबरशी जुळत नाही';
      throw err;
    }

    const nowIso = new Date().toISOString();

    // 1. Cascade delete in SQLite under atomic transaction
    db.transaction(() => {
      // Items and lists
      db.prepare('DELETE FROM shopping_items WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM shopping_lists WHERE user_id = ?').run(user.id);
      // Sync operations
      db.prepare('DELETE FROM sync_operations WHERE user_id = ?').run(user.id);
      // Sessions
      db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(user.id);
      // Recovery authorizations & codes
      db.prepare('DELETE FROM recovery_authorizations WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
      // Recovery requests
      db.prepare('DELETE FROM recovery_requests WHERE user_id = ? OR mobile_number = ?').run(user.id, user.mobile_number);
      // Users table
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();

    // 2. Firestore Deletion attempt (if configured and credentials exist)
    let firestoreDeleted = false;
    let firestoreMessage = 'Not configured or skipped';

    const saKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (saKeyPath && fs.existsSync(saKeyPath)) {
      try {
        const firestore = getAdminFirestore();
        if (firestore) {
          // Delete user doc from firestore
          await firestore.collection('users').doc(user.id).delete();
          // Delete lists subcollections or top-level collections
          const listsSnap = await firestore.collection('shoppingLists').where('userId', '==', user.id).get();
          const batch = firestore.batch();
          listsSnap.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
          firestoreDeleted = true;
          firestoreMessage = 'Deleted from Firestore';
        }
      } catch (e: any) {
        firestoreDeleted = false;
        firestoreMessage = `Firestore deletion skipped or failed: ${e.message}`;
      }
    } else {
      firestoreDeleted = false;
      firestoreMessage = 'Firestore service account not configured; cloud sync skipped';
    }

    // 3. Record in audit log (retaining only minimal metadata)
    this.logAudit({
      adminUserId: params.adminUserId,
      action: 'ACCOUNT_DELETED',
      targetAccountId: user.id,
      targetMobileNumber: user.mobile_number,
      details: {
        deletedAt: nowIso,
        sqliteDeleted: true,
        firestoreDeleted,
        firestoreMessage
      },
      ipAddress: params.ipAddress
    });

    return {
      success: true,
      deletedAccountId: user.id,
      deletedAt: nowIso,
      sqliteDeleted: true,
      firestoreDeleted,
      firestoreMessage
    };
  }

  /**
   * Delete all eligible ordinary user accounts in one confirmed operation.
   * Requires exact confirmation phrase: "DELETE ALL ORDINARY USERS".
   * Strict protection: Owner account (9356755100) and any admin role accounts are NEVER deleted.
   * Cascades lists, items, sessions, recovery codes, recovery requests.
   */
  static async bulkDeleteAccounts(params: {
    adminUserId: string;
    confirmationPhrase: string;
    expectedCount?: number;
    ipAddress?: string;
  }): Promise<{
    success: boolean;
    deletedCount: number;
    deletedAccountIds: string[];
    deletedAt: string;
    cascadedTotals: Record<string, number>;
  }> {
    if (!params.confirmationPhrase || params.confirmationPhrase.trim() !== 'DELETE ALL ORDINARY USERS') {
      const err: any = new Error('CONFIRMATION_MISMATCH: Confirmation phrase must be DELETE ALL ORDINARY USERS');
      err.status = 400;
      err.code = 'CONFIRMATION_MISMATCH';
      err.errorMr = 'खात्री शब्द DELETE ALL ORDINARY USERS असणे आवश्यक आहे';
      throw err;
    }

    const db = getDatabase();
    const ownerMobile = config.adminMobileNumber || '9356755100';
    const ownerId = '24c7311d-9cb0-41c0-a0ed-cfee2ed69552';

    // Find all ordinary, non-admin user accounts, strictly excluding owner and calling admin
    const ordinaryUsers = db.prepare(`
      SELECT id, mobile_number, full_name
      FROM users
      WHERE role != 'admin'
        AND id != ?
        AND id != ?
        AND mobile_number != ?
        AND mobile_number != '9356755100'
    `).all(params.adminUserId, ownerId, ownerMobile) as Array<{ id: string; mobile_number: string; full_name: string }>;

    const deletedAccountIds = ordinaryUsers.map(u => u.id);
    const deletedCount = ordinaryUsers.length;
    const nowIso = new Date().toISOString();

    const cascadedTotals: Record<string, number> = {
      users: deletedCount,
      shopping_lists: 0,
      shopping_items: 0,
      authentication_sessions: 0,
      recovery_codes: 0,
      recovery_authorizations: 0,
      recovery_requests: 0,
      sync_operations: 0
    };

    if (deletedCount > 0) {
      db.transaction(() => {
        for (const user of ordinaryUsers) {
          const itemRes = db.prepare('DELETE FROM shopping_items WHERE user_id = ?').run(user.id);
          cascadedTotals.shopping_items += itemRes.changes;

          const listRes = db.prepare('DELETE FROM shopping_lists WHERE user_id = ?').run(user.id);
          cascadedTotals.shopping_lists += listRes.changes;

          const syncRes = db.prepare('DELETE FROM sync_operations WHERE user_id = ?').run(user.id);
          cascadedTotals.sync_operations += syncRes.changes;

          const sessRes = db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(user.id);
          cascadedTotals.authentication_sessions += sessRes.changes;

          const authRes = db.prepare('DELETE FROM recovery_authorizations WHERE user_id = ?').run(user.id);
          cascadedTotals.recovery_authorizations += authRes.changes;

          const codeRes = db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
          cascadedTotals.recovery_codes += codeRes.changes;

          const reqRes = db.prepare('DELETE FROM recovery_requests WHERE user_id = ? OR mobile_number = ?').run(user.id, user.mobile_number);
          cascadedTotals.recovery_requests += reqRes.changes;

          db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        }
      })();
    }

    // Record audit event
    this.logAudit({
      adminUserId: params.adminUserId,
      action: 'ACCOUNTS_BULK_DELETED',
      details: {
        deletedCount,
        deletedAccountIds,
        cascadedTotals,
        confirmationPhrase: params.confirmationPhrase.trim()
      },
      ipAddress: params.ipAddress
    });

    return {
      success: true,
      deletedCount,
      deletedAccountIds,
      deletedAt: nowIso,
      cascadedTotals
    };
  }

  /**
   * Archive one audit log entry from the active audit view.
   * Preserves entry in immutable storage while hiding from default view.
   */
  static archiveAuditLog(params: {
    id: string;
    adminUserId: string;
    ipAddress?: string;
  }): { success: boolean; id: string; archived_at: string } {
    const db = getDatabase();
    const entry = db.prepare('SELECT * FROM admin_audit_logs WHERE id = ?').get(params.id) as AdminAuditLogRecord | undefined;

    if (!entry) {
      const err: any = new Error('NOT_FOUND: Audit log entry does not exist');
      err.status = 404;
      err.code = 'NOT_FOUND';
      err.errorMr = 'ऑडिट लॉग नोंद आढळली नाही';
      throw err;
    }

    if (entry.is_archived) {
      const err: any = new Error('ALREADY_ARCHIVED: Audit log entry is already archived');
      err.status = 400;
      err.code = 'ALREADY_ARCHIVED';
      err.errorMr = 'ऑडिट लॉग नोंद आधीच संग्रहित केली आहे';
      throw err;
    }

    const nowIso = new Date().toISOString();
    db.prepare('UPDATE admin_audit_logs SET is_archived = 1, archived_at = ? WHERE id = ?').run(nowIso, entry.id);

    // Record audit event for this archival
    this.logAudit({
      adminUserId: params.adminUserId,
      action: 'AUDIT_LOG_ARCHIVED',
      targetAccountId: entry.target_account_id,
      targetMobileNumber: entry.target_mobile_number,
      details: { archivedLogId: entry.id, previousAction: entry.action },
      ipAddress: params.ipAddress
    });

    return {
      success: true,
      id: entry.id,
      archived_at: nowIso
    };
  }

  /**
   * Remove/archive all active audit logs from the active view in one confirmed operation.
   * Requires exact confirmation phrase: "DELETE ALL AUDIT LOGS".
   * Preserves historical logs with is_archived = 1, and inserts an active AUDIT_LOGS_BULK_ARCHIVED event.
   */
  static bulkArchiveAuditLogs(params: {
    adminUserId: string;
    confirmationPhrase: string;
    ipAddress?: string;
  }): { success: boolean; count: number; archived_at: string } {
    if (!params.confirmationPhrase || params.confirmationPhrase.trim() !== 'DELETE ALL AUDIT LOGS') {
      const err: any = new Error('CONFIRMATION_MISMATCH: Confirmation phrase must be DELETE ALL AUDIT LOGS');
      err.status = 400;
      err.code = 'CONFIRMATION_MISMATCH';
      err.errorMr = 'खात्री शब्द DELETE ALL AUDIT LOGS असणे आवश्यक आहे';
      throw err;
    }

    const db = getDatabase();
    const countRow = db.prepare('SELECT COUNT(*) as count FROM admin_audit_logs WHERE COALESCE(is_archived, 0) = 0').get() as { count: number };
    const count = countRow ? countRow.count : 0;

    const nowIso = new Date().toISOString();
    if (count > 0) {
      db.prepare('UPDATE admin_audit_logs SET is_archived = 1, archived_at = ? WHERE COALESCE(is_archived, 0) = 0').run(nowIso);
    }

    // Insert active bulk archive event (is_archived = 0 so it stays visible in active logs)
    this.logAudit({
      adminUserId: params.adminUserId,
      action: 'AUDIT_LOGS_BULK_ARCHIVED',
      details: { archivedCount: count, confirmationPhrase: params.confirmationPhrase.trim() },
      ipAddress: params.ipAddress
    });

    return {
      success: true,
      count,
      archived_at: nowIso
    };
  }

  /**
   * Get Audit Logs. Defaults to active (unarchived) logs.
   * Sets timestamp: l.created_at as well as created_at for frontend compatibility.
   */
  static getAuditLogs(params: {
    page?: number;
    limit?: number;
    action?: string;
    search?: string;
    showArchived?: boolean;
  }): {
    logs: Array<AdminAuditLogRecord & { admin_name?: string; timestamp: string }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  } {
    const db = getDatabase();
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 50));
    const offset = (page - 1) * limit;

    let whereClause = params.showArchived
      ? 'COALESCE(l.is_archived, 0) = 1'
      : 'COALESCE(l.is_archived, 0) = 0';
    const whereArgs: any[] = [];

    if (params.action && params.action.trim() && params.action !== 'ALL') {
      whereClause += ' AND l.action = ?';
      whereArgs.push(params.action.trim());
    }

    if (params.search && params.search.trim()) {
      const q = `%${params.search.trim()}%`;
      whereClause += ' AND (l.target_mobile_number LIKE ? OR l.target_account_id LIKE ? OR l.action LIKE ? OR l.details LIKE ?)';
      whereArgs.push(q, q, q, q);
    }

    const countRow = db.prepare(`
      SELECT COUNT(*) as count FROM admin_audit_logs l WHERE ${whereClause}
    `).get(...whereArgs) as { count: number };

    const total = countRow ? countRow.count : 0;
    const totalPages = Math.ceil(total / limit) || 1;

    const rows = db.prepare(`
      SELECT 
        l.*,
        u.full_name as admin_name
      FROM admin_audit_logs l
      LEFT JOIN users u ON l.admin_user_id = u.id
      WHERE ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...whereArgs, limit, offset) as any[];

    const logs = rows.map(r => ({
      ...r,
      timestamp: r.created_at
    }));

    return {
      logs,
      total,
      page,
      limit,
      totalPages
    };
  }
}

