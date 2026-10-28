import { getDatabase } from '../db/database.js';
import {
  hashPin,
  verifyPin,
  generateSessionToken,
  hashToken,
  generateId,
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
  generateRecoveryAuthToken
} from '../utils/crypto.js';
import { normalizeMobileNumber, validatePin } from '../utils/validation.js';
import { FirebaseAuthService } from './firebaseAuthService.js';
import { AdminService } from './adminService.js';
import { TelegramService } from './telegramService.js';
import { SecurityService } from './securityService.js';
import { config } from '../config.js';
import type { User, SafeUser, RecoveryCodeRecord, RecoveryAuthorizationRecord, RecoveryRequestRecord } from '../types/index.js';

export interface SessionVerificationResult {
  status: 'VALID' | 'LOCKED' | 'REVOKED' | 'EXPIRED' | 'INVALID';
  user?: SafeUser;
  code?: string;
  reasonCode?: string;
  error?: string;
  errorMr?: string;
  lockType?: 'AUTOMATIC' | 'ADMINISTRATIVE' | null;
  lockReason?: string | null;
  failedAttempts?: number;
  maxAttempts?: number;
  remainingAttempts?: number;
  nextAction?: 'REACTIVATION_REQUIRED' | 'LOGIN_REQUIRED' | null;
}

// Rate limiting & lockout tracking for unauthenticated / non-existent accounts
// Prevents mobile number enumeration while ensuring all targets observe strict 4-attempt / 24-hr lockout
const unregisteredRecoveryAttempts = new Map<string, { attempts: number; lockedUntil: string | null }>();

export function resetUnregisteredRecoveryAttempts(): void {
  unregisteredRecoveryAttempts.clear();
}

export class AuthService {
  static register(data: {
    mobileNumber: string;
    pin: string;
    fullName: string;
    preferredLanguage?: 'en' | 'mr';
    deviceInfo?: string;
    pinLength?: 4 | 6;
  }): { user: SafeUser; token: string; recoveryCode: string } {
    const normalizedMobile = normalizeMobileNumber(data.mobileNumber);
    if (!normalizedMobile) {
      throw new Error('INVALID_MOBILE: Please enter a valid 10-digit mobile number');
    }

    const expectedLength: 4 | 6 = data.pinLength || (data.pin.length === 4 ? 4 : 6);
    if (!validatePin(data.pin, expectedLength)) {
      throw new Error(`INVALID_PIN: PIN must be exactly ${expectedLength} digits`);
    }

    const fullName = (data.fullName || '').trim();
    if (!fullName || fullName.length < 2) {
      throw new Error('INVALID_NAME: Name must be at least 2 characters');
    }

    const db = getDatabase();

    // Check if user already exists
    const existing = db.prepare('SELECT id FROM users WHERE mobile_number = ?').get(normalizedMobile);
    if (existing) {
      throw new Error('USER_EXISTS: An account with this mobile number already exists');
    }

    const userId = generateId();
    const now = new Date().toISOString();
    const { hash, salt } = hashPin(data.pin);
    const lang = data.preferredLanguage === 'en' ? 'en' : 'mr';

    // Generate cryptographically secure Recovery Code
    const recoveryCode = generateRecoveryCode();
    const { hash: codeHash, salt: codeSalt } = hashRecoveryCode(recoveryCode);
    const recoveryCodeId = generateId();

    // Create initial session
    const { rawToken, tokenHash } = generateSessionToken();
    const sessionId = generateId();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (
          id, mobile_number, pin_hash, salt, full_name, preferred_language,
          failed_login_attempts, locked_until, pin_length, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, 'user', ?, ?)
      `).run(userId, normalizedMobile, hash, salt, fullName, lang, expectedLength, now, now);

      db.prepare(`
        INSERT INTO recovery_codes (
          id, user_id, code_hash, salt, status, failed_attempts, locked_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ACTIVE', 0, NULL, ?, ?)
      `).run(recoveryCodeId, userId, codeHash, codeSalt, now, now);

      db.prepare(`
        INSERT INTO authentication_sessions (
          id, user_id, token_hash, device_info, expires_at, created_at, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, userId, tokenHash, data.deviceInfo || null, expiresAt, now, now);
    })();

    const safeUser: SafeUser = {
      id: userId,
      mobile_number: normalizedMobile,
      full_name: fullName,
      preferred_language: lang,
      failed_login_attempts: 0,
      locked_until: null,
      pin_length: expectedLength,
      role: 'user',
      created_at: now,
      updated_at: now
    };

    // Notify Telegram Admin asynchronously (safe fire-and-forget, never breaks registration)
    void TelegramService.notifyNewMemberRegistration({
      mobileNumber: normalizedMobile,
      fullName,
      preferredLanguage: lang,
      role: 'user',
      createdAt: now
    }).catch(err => console.warn('[AuthService] Telegram registration notification notice:', err?.message));

    return { user: safeUser, token: rawToken, recoveryCode };
  }

  static recordLoginAttempt(params: {
    userId?: string | null;
    mobileNumber: string;
    outcome: 'SUCCESS' | 'FAILURE';
    reason: 'INCORRECT_PIN' | 'ACCOUNT_LOCKED' | 'INVALID_MOBILE' | 'AUTHENTICATION_ERROR' | 'SUCCESS' | 'ACCOUNT_NOT_FOUND';
    consecutiveFailedAttempts: number;
    lockTriggered?: boolean;
    lockType?: 'AUTOMATIC' | 'ADMINISTRATIVE' | null;
    ipAddress?: string | null;
    requestId?: string | null;
  }): void {
    try {
      const db = getDatabase();
      const id = generateId();
      const attemptedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO login_attempts (
          id, user_id, mobile_number, attempted_at, outcome, reason,
          consecutive_failed_attempts, lock_triggered, lock_type, ip_address, request_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        params.userId || null,
        params.mobileNumber,
        attemptedAt,
        params.outcome,
        params.reason,
        params.consecutiveFailedAttempts,
        params.lockTriggered ? 1 : 0,
        params.lockType || null,
        params.ipAddress || null,
        params.requestId || null
      );
    } catch (e) {
      console.error('Failed to record login attempt:', e);
    }
  }

  static login(data: {
    mobileNumber: string;
    pin: string;
    deviceInfo?: string;
    ipAddress?: string;
    requestId?: string;
  }): { user: SafeUser; token: string } {
    const rawMobile = (data.mobileNumber || '').trim();
    const normalizedMobile = normalizeMobileNumber(rawMobile);
    if (!normalizedMobile || !validatePin(data.pin)) {
      AuthService.recordLoginAttempt({
        userId: null,
        mobileNumber: (rawMobile || 'unknown').slice(0, 15),
        outcome: 'FAILURE',
        reason: !normalizedMobile ? 'INVALID_MOBILE' : 'INCORRECT_PIN',
        consecutiveFailedAttempts: 0,
        ipAddress: data.ipAddress,
        requestId: data.requestId
      });
      const err: any = new Error('INVALID_CREDENTIALS: Invalid mobile number or PIN');
      err.status = 400;
      err.code = 'INVALID_CREDENTIALS';
      err.errorMr = 'अवैध मोबाईल क्रमांक किंवा पिन';
      throw err;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;

    if (!user) {
      // Prevent user enumeration by logging internally and returning generic error with no attempt counter
      AuthService.recordLoginAttempt({
        userId: null,
        mobileNumber: normalizedMobile,
        outcome: 'FAILURE',
        reason: 'ACCOUNT_NOT_FOUND',
        consecutiveFailedAttempts: 0,
        ipAddress: data.ipAddress,
        requestId: data.requestId
      });
      const err: any = new Error('INVALID_CREDENTIALS: Invalid mobile number or PIN');
      err.status = 400;
      err.code = 'INVALID_CREDENTIALS';
      err.errorMr = 'अवैध मोबाईल क्रमांक किंवा पिन';
      throw err;
    }

    const now = new Date();
    const isOwnerAdmin = normalizedMobile === '9356755100' || user.role === 'admin';

    // Check account lockout
    let isLocked = false;
    if (user.locked_until) {
      const lockExpiry = new Date(user.locked_until);
      if (lockExpiry.getTime() > now.getTime()) {
        isLocked = true;
      }
    }

    if (isLocked) {
      AuthService.recordLoginAttempt({
        userId: user.id,
        mobileNumber: normalizedMobile,
        outcome: 'FAILURE',
        reason: 'ACCOUNT_LOCKED',
        consecutiveFailedAttempts: user.failed_login_attempts || 5,
        lockTriggered: false,
        lockType: user.lock_type || 'AUTOMATIC',
        ipAddress: data.ipAddress,
        requestId: data.requestId
      });

      const isAdministrative = user.lock_type === 'ADMINISTRATIVE';
      const lockReasonText = user.lock_reason || (isAdministrative ? 'Locked by administrator' : 'Too many failed login attempts (5 of 5)');
      const err: any = new Error(
        isAdministrative
          ? `ACCOUNT_LOCKED: Account is administratively locked. Reason: ${lockReasonText}`
          : 'ACCOUNT_LOCKED: Your account has been locked after 5 consecutive failed attempts.'
      );
      err.status = 423;
      err.code = 'ACCOUNT_LOCKED';
      err.nextAction = 'REACTIVATION_REQUIRED';
      err.lockType = user.lock_type || (isAdministrative ? 'ADMINISTRATIVE' : 'AUTOMATIC');
      err.lockReason = lockReasonText;
      err.failedAttempts = user.failed_login_attempts || 5;
      err.maxAttempts = 5;
      err.remainingAttempts = 0;
      err.errorMr = isAdministrative
        ? `खाते प्रशासकीय कारणास्तव लॉक केले आहे: ${lockReasonText}`
        : '५ सलग अयशस्वी प्रयत्नांनंतर आपले खाते लॉक केले गेले आहे.';
      throw err;
    }

    // Verify PIN
    const userPinLength = user.pin_length || 6;
    const isValidLength = data.pin.length === userPinLength;
    const isValidHash = isValidLength && verifyPin(data.pin, user.salt, user.pin_hash);

    if (!isValidHash) {
      if (isOwnerAdmin) {
        // Owner admin account is protected from lockout
        AuthService.recordLoginAttempt({
          userId: user.id,
          mobileNumber: normalizedMobile,
          outcome: 'FAILURE',
          reason: 'INCORRECT_PIN',
          consecutiveFailedAttempts: 0,
          ipAddress: data.ipAddress,
          requestId: data.requestId
        });
        const err: any = new Error('INVALID_CREDENTIALS: Incorrect PIN.');
        err.status = 400;
        err.code = 'INCORRECT_PIN';
        err.errorMr = 'चुकीचा पिन.';
        throw err;
      }

      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const maxAttempts = 5;

      if (newAttempts >= maxAttempts) {
        // Lock account strictly on 5th consecutive failure
        const lockIso = '9999-12-31T23:59:59.999Z';
        const lockType = 'AUTOMATIC';
        const lockReason = 'Too many failed login attempts (5 of 5)';
        const nowIso = now.toISOString();

        db.transaction(() => {
          db.prepare(`
            UPDATE users
            SET failed_login_attempts = 5,
                locked_until = ?,
                lock_type = ?,
                lock_reason = ?,
                updated_at = ?
            WHERE id = ?
          `).run(lockIso, lockType, lockReason, nowIso, user.id);

          // Invalidate all active sessions immediately and record in security service
          SecurityService.revokeUserSessions(user.id, 'ACCOUNT_LOCKED_PIN_ATTEMPTS', lockReason, 'AUTOMATIC');
        })();

        AuthService.recordLoginAttempt({
          userId: user.id,
          mobileNumber: normalizedMobile,
          outcome: 'FAILURE',
          reason: 'INCORRECT_PIN',
          consecutiveFailedAttempts: 5,
          lockTriggered: true,
          lockType: 'AUTOMATIC',
          ipAddress: data.ipAddress,
          requestId: data.requestId
        });

        // Notify Telegram Admin asynchronously (safe fire-and-forget, never breaks authentication response)
        void TelegramService.notifyAutomaticAccountLocked({
          mobileNumber: normalizedMobile,
          fullName: user.full_name,
          failedAttempts: 5,
          lockType: 'AUTOMATIC',
          reason: lockReason,
          lockedAt: nowIso
        }).catch(err => console.warn('[AuthService] Telegram lock alert notice:', err?.message));

        const err: any = new Error('ACCOUNT_LOCKED: Your account has been locked after 5 consecutive failed attempts.');
        err.status = 423;
        err.code = 'ACCOUNT_LOCKED';
        err.nextAction = 'REACTIVATION_REQUIRED';
        err.lockType = lockType;
        err.lockReason = lockReason;
        err.failedAttempts = 5;
        err.maxAttempts = 5;
        err.remainingAttempts = 0;
        err.errorMr = '५ सलग अयशस्वी प्रयत्नांनंतर आपले खाते लॉक केले गेले आहे.';
        throw err;
      } else {
        const nowIso = now.toISOString();
        db.prepare(`
          UPDATE users
          SET failed_login_attempts = ?, updated_at = ?
          WHERE id = ?
        `).run(newAttempts, nowIso, user.id);

        AuthService.recordLoginAttempt({
          userId: user.id,
          mobileNumber: normalizedMobile,
          outcome: 'FAILURE',
          reason: 'INCORRECT_PIN',
          consecutiveFailedAttempts: newAttempts,
          lockTriggered: false,
          lockType: null,
          ipAddress: data.ipAddress,
          requestId: data.requestId
        });

        const remaining = maxAttempts - newAttempts;
        const err: any = new Error(`INVALID_CREDENTIALS: Incorrect PIN. Failed attempts: ${newAttempts} of ${maxAttempts}.`);
        err.status = 400;
        err.code = 'INCORRECT_PIN';
        err.failedAttempts = newAttempts;
        err.maxAttempts = maxAttempts;
        err.remainingAttempts = remaining;
        err.errorMr = `चुकीचा पिन. अयशस्वी प्रयत्न: ${newAttempts} पैकी ५.`;
        throw err;
      }
    }

    // Successful login: reset attempts, clear lock, and record genuine last_login_at
    const loginIso = now.toISOString();
    db.prepare(`
      UPDATE users
      SET failed_login_attempts = 0,
          locked_until = NULL,
          lock_type = NULL,
          lock_reason = NULL,
          last_login_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(loginIso, loginIso, user.id);

    AuthService.recordLoginAttempt({
      userId: user.id,
      mobileNumber: normalizedMobile,
      outcome: 'SUCCESS',
      reason: 'SUCCESS',
      consecutiveFailedAttempts: 0,
      lockTriggered: false,
      lockType: null,
      ipAddress: data.ipAddress,
      requestId: data.requestId
    });

    // Create session
    const { rawToken, tokenHash } = generateSessionToken();
    const sessionId = generateId();
    const expiresAt = new Date(now.getTime() + config.sessionTtlHours * 3600 * 1000).toISOString();

    db.prepare(`
      INSERT INTO authentication_sessions (
        id, user_id, token_hash, device_info, expires_at, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, user.id, tokenHash, data.deviceInfo || null, expiresAt, loginIso, loginIso);

    const safeUser: SafeUser = {
      id: user.id,
      mobile_number: user.mobile_number,
      full_name: user.full_name,
      preferred_language: user.preferred_language,
      failed_login_attempts: 0,
      locked_until: null,
      lock_type: null,
      lock_reason: null,
      pin_length: userPinLength,
      role: (user.role || 'user') as 'user' | 'admin',
      last_login_at: loginIso,
      created_at: user.created_at,
      updated_at: user.updated_at
    };

    return { user: safeUser, token: rawToken };
  }

  static logout(token: string): boolean {
    if (!token) return false;
    const tokenHash = hashToken(token);
    const db = getDatabase();
    const result = db.prepare('DELETE FROM authentication_sessions WHERE token_hash = ?').run(tokenHash);
    return result.changes > 0;
  }

  static changePin(userId: string, currentPin: string, newPin: string, newPinLength?: 4 | 6): boolean {
    const expectedNewLength: 4 | 6 = newPinLength || (newPin.length === 4 ? 4 : 6);

    if (!validatePin(currentPin) || !validatePin(newPin, expectedNewLength)) {
      throw new Error(`INVALID_PIN: New PIN must be exactly ${expectedNewLength} digits`);
    }

    if (currentPin === newPin) {
      throw new Error('PIN_IDENTICAL: New PIN must be different from current PIN');
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;

    if (!user) {
      throw new Error('USER_NOT_FOUND: User does not exist');
    }

    const isValid = verifyPin(currentPin, user.salt, user.pin_hash);
    if (!isValid) {
      throw new Error('INVALID_CURRENT_PIN: Current PIN is incorrect');
    }

    const { hash, salt } = hashPin(newPin);
    const now = new Date().toISOString();

    db.transaction(() => {
      // Update PIN and pin_length
      db.prepare(`
        UPDATE users
        SET pin_hash = ?, salt = ?, pin_length = ?, updated_at = ?
        WHERE id = ?
      `).run(hash, salt, expectedNewLength, now, userId);

      // Invalidate all existing sessions and record security revocation
      SecurityService.revokeUserSessions(userId, 'SESSION_REVOKED_SECURITY', 'PIN changed by user', null);
    })();

    // Notify Telegram Admin asynchronously
    void TelegramService.notifyPinChanged({
      userId,
      mobileNumber: user.mobile_number,
      fullName: user.full_name,
      timestamp: now
    }).catch(err => console.warn('[AuthService] Telegram PIN changed notice:', err?.message));

    return true;
  }

  static async resetPinWithOtp(data: {
    mobileNumber: string;
    newPin: string;
    newPinLength?: 4 | 6;
    firebaseIdToken: string;
  }): Promise<{ success: boolean; message: string; messageMr: string }> {
    const normalizedMobile = normalizeMobileNumber(data.mobileNumber);
    if (!normalizedMobile) {
      throw new Error('INVALID_MOBILE: Please enter a valid 10-digit mobile number');
    }

    const expectedLength: 4 | 6 = data.newPinLength || (data.newPin.length === 4 ? 4 : 6);
    if (!validatePin(data.newPin, expectedLength)) {
      throw new Error(`INVALID_PIN: New PIN must be exactly ${expectedLength} digits`);
    }

    // 1. Verify Firebase ID Token
    const verifiedToken = await FirebaseAuthService.verifyIdToken(data.firebaseIdToken);

    // 2. Ensure OTP verification cannot reset another user's PIN
    if (!FirebaseAuthService.verifyPhoneMatch(verifiedToken.phoneNumber, normalizedMobile)) {
      throw new Error('UNAUTHORIZED_RESET: Verified phone number does not match requested mobile number');
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;

    if (!user) {
      throw new Error('USER_NOT_FOUND: No registered account found for this mobile number');
    }

    const { hash, salt } = hashPin(data.newPin);
    const now = new Date().toISOString();

    db.transaction(() => {
      // Update PIN hash, salt, pin_length, reset lockout/attempts
      db.prepare(`
        UPDATE users
        SET pin_hash = ?, salt = ?, pin_length = ?, failed_login_attempts = 0, locked_until = NULL, lock_type = NULL, lock_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(hash, salt, expectedLength, now, user.id);

      // Invalidate all active sessions for this user
      db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(user.id);
    })();

    // Notify Telegram Admin asynchronously
    void TelegramService.notifyPinResetSuccess({
      mobileNumber: normalizedMobile,
      fullName: user.full_name || null,
      method: 'PHONE_OTP',
      timestamp: now
    }).catch(err => console.warn('[AuthService] Telegram OTP reset notice:', err?.message));

    return {
      success: true,
      message: 'PIN has been reset successfully. Please log in with your new PIN.',
      messageMr: 'पिन यशस्वीरित्या बदलला आहे. कृपया नवीन पिनने लॉगिन करा.'
    };
  }

  static verifySessionWithStatus(token: string): SessionVerificationResult {
    if (!token || typeof token !== 'string') {
      return {
        status: 'INVALID',
        code: 'AUTH_REQUIRED',
        error: 'AUTH_REQUIRED: Please log in to access this resource',
        errorMr: 'कृपया या सुविधेसाठी प्रथम लॉगिन करा',
        nextAction: 'LOGIN_REQUIRED'
      };
    }

    const tokenHash = hashToken(token);
    const db = getDatabase();
    const nowIso = new Date().toISOString();

    const row = db.prepare(`
      SELECT s.id as session_id, u.*
      FROM authentication_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, nowIso) as (User & { session_id: string }) | undefined;

    if (!row) {
      // Check if session was revoked due to an explicit security action or account lock
      const revokedInfo = SecurityService.getRevokedToken(tokenHash);
      if (revokedInfo) {
        const isLock = revokedInfo.reasonCode.startsWith('ACCOUNT_LOCKED');
        if (isLock) {
          const isAdministrative = revokedInfo.lockType === 'ADMINISTRATIVE';
          return {
            status: 'LOCKED',
            code: revokedInfo.reasonCode,
            reasonCode: revokedInfo.reasonCode,
            error: isAdministrative
              ? `ACCOUNT_LOCKED: Account is administratively locked. Reason: ${revokedInfo.lockReason || 'Administrative account lockout'}`
              : 'ACCOUNT_LOCKED: Your account has been locked after repeated incorrect PIN attempts. To regain access, submit a reactivation request.',
            errorMr: isAdministrative
              ? `खाते प्रशासकीय कारणास्तव लॉक केले आहे: ${revokedInfo.lockReason || 'प्रशासकीय लॉक'}`
              : 'वारंवार चुकीचा पिन टाकल्यामुळे तुमचे खाते लॉक केले आहे. पुन्हा प्रवेश मिळवण्यासाठी खाते पुन्हा सुरू करण्याची विनंती करा.',
            lockType: revokedInfo.lockType || (isAdministrative ? 'ADMINISTRATIVE' : 'AUTOMATIC'),
            lockReason: revokedInfo.lockReason || null,
            nextAction: 'REACTIVATION_REQUIRED'
          };
        }

        return {
          status: 'REVOKED',
          code: 'SESSION_REVOKED_SECURITY',
          reasonCode: 'SESSION_REVOKED_SECURITY',
          error: 'SESSION_REVOKED_SECURITY: Your session has been revoked for security reasons. Please sign in again. If your account is locked, follow the account recovery or reactivation instructions.',
          errorMr: 'सुरक्षिततेच्या कारणामुळे तुमचे सत्र रद्द केले आहे. कृपया पुन्हा लॉगिन करा. खाते लॉक असल्यास खाते पुनर्प्राप्ती किंवा पुन्हा सुरू करण्याच्या सूचनांचे पालन करा.',
          nextAction: 'LOGIN_REQUIRED'
        };
      }

      return {
        status: 'EXPIRED',
        code: 'SESSION_EXPIRED',
        reasonCode: 'SESSION_EXPIRED',
        error: 'SESSION_EXPIRED: Your session has expired. Please sign in again.',
        errorMr: 'आपले सत्र संपले आहे. कृपया पुन्हा लॉगिन करा.',
        nextAction: 'LOGIN_REQUIRED'
      };
    }

    // Reject session with explicit details if account is locked
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      const isAdministrative = row.lock_type === 'ADMINISTRATIVE';
      const reasonCode = isAdministrative ? 'ACCOUNT_LOCKED_SECURITY_REVIEW' : 'ACCOUNT_LOCKED_PIN_ATTEMPTS';
      const lockReasonText = row.lock_reason || (isAdministrative ? 'Administrative account lockout' : 'Too many failed login attempts (5 of 5)');

      return {
        status: 'LOCKED',
        code: 'ACCOUNT_LOCKED',
        reasonCode,
        error: isAdministrative
          ? `ACCOUNT_LOCKED: Account is administratively locked. Reason: ${lockReasonText}`
          : 'ACCOUNT_LOCKED: Your account has been locked after repeated incorrect PIN attempts. To regain access, submit a reactivation request.',
        errorMr: isAdministrative
          ? `खाते प्रशासकीय कारणास्तव लॉक केले आहे: ${lockReasonText}`
          : 'वारंवार चुकीचा पिन टाकल्यामुळे तुमचे खाते लॉक केले आहे. पुन्हा प्रवेश मिळवण्यासाठी खाते पुन्हा सुरू करण्याची विनंती करा.',
        lockType: row.lock_type || (isAdministrative ? 'ADMINISTRATIVE' : 'AUTOMATIC'),
        lockReason: lockReasonText,
        failedAttempts: row.failed_login_attempts || 5,
        maxAttempts: 5,
        remainingAttempts: 0,
        nextAction: 'REACTIVATION_REQUIRED',
        user: {
          id: row.id,
          mobile_number: row.mobile_number,
          full_name: row.full_name,
          preferred_language: row.preferred_language,
          failed_login_attempts: row.failed_login_attempts || 5,
          locked_until: row.locked_until,
          lock_type: row.lock_type,
          lock_reason: lockReasonText,
          pin_length: row.pin_length || 6,
          role: (row.role || 'user') as 'user' | 'admin',
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      };
    }

    // Update last_active_at
    db.prepare('UPDATE authentication_sessions SET last_active_at = ? WHERE id = ?').run(nowIso, row.session_id);

    return {
      status: 'VALID',
      user: {
        id: row.id,
        mobile_number: row.mobile_number,
        full_name: row.full_name,
        preferred_language: row.preferred_language,
        failed_login_attempts: row.failed_login_attempts,
        locked_until: row.locked_until,
        lock_type: row.lock_type || null,
        lock_reason: row.lock_reason || null,
        pin_length: row.pin_length || 6,
        role: (row.role || 'user') as 'user' | 'admin',
        created_at: row.created_at,
        updated_at: row.updated_at
      }
    };
  }

  static verifySession(token: string): SafeUser | null {
    const res = this.verifySessionWithStatus(token);
    return res.status === 'VALID' ? res.user! : null;
  }

  static generateRecoveryCodeForUser(userId: string): { recoveryCode: string; isReplacement: boolean } {
    const db = getDatabase();
    const user = db.prepare('SELECT id, mobile_number, full_name FROM users WHERE id = ?').get(userId) as User | undefined;
    if (!user) {
      const err: any = new Error('USER_NOT_FOUND: User does not exist');
      err.status = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    const recoveryCode = generateRecoveryCode();
    const { hash: codeHash, salt: codeSalt } = hashRecoveryCode(recoveryCode);
    const codeId = generateId();
    const nowIso = new Date().toISOString();

    let isReplacement = false;

    db.transaction(() => {
      const existing = db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND status = ?').get(userId, 'ACTIVE') as { id: string } | undefined;
      if (existing) {
        isReplacement = true;
        db.prepare(`
          UPDATE recovery_codes
          SET status = 'REPLACED', updated_at = ?
          WHERE id = ?
        `).run(nowIso, existing.id);
      }

      db.prepare(`
        INSERT INTO recovery_codes (
          id, user_id, code_hash, salt, status, failed_attempts, locked_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ACTIVE', 0, NULL, ?, ?)
      `).run(codeId, userId, codeHash, codeSalt, nowIso, nowIso);
    })();

    // Notify Telegram Admin asynchronously (zero code leak)
    void TelegramService.notifyRecoveryCodeIssued({
      userId,
      mobileNumber: user.mobile_number,
      fullName: user.full_name || null,
      isReplacement,
      timestamp: nowIso
    }).catch(err => console.warn('[AuthService] Telegram recovery code issued notice:', err?.message));

    return {
      recoveryCode,
      isReplacement
    };
  }

  static getRecoveryCodeStatus(userId: string): { hasRecoveryCode: boolean; status: string; createdAt: string | null } {
    const db = getDatabase();
    const active = db.prepare('SELECT status, created_at FROM recovery_codes WHERE user_id = ? AND status = ?').get(userId, 'ACTIVE') as { status: string; created_at: string } | undefined;
    return {
      hasRecoveryCode: Boolean(active),
      status: active ? 'ACTIVE' : 'NONE',
      createdAt: active?.created_at || null
    };
  }

  static verifyRecoveryCode(mobileNumber: string, recoveryCode: string): { resetToken: string; pinLength: 4 | 6 } {
    const normalizedMobile = normalizeMobileNumber(mobileNumber);
    if (!normalizedMobile) {
      const err: any = new Error('INVALID_RECOVERY_CODE: Invalid mobile number or Recovery Code');
      err.status = 400;
      err.code = 'INVALID_RECOVERY_CODE';
      err.errorMr = 'अवैध मोबाइल नंबर किंवा रिकव्हरी कोड';
      throw err;
    }

    if (!recoveryCode || typeof recoveryCode !== 'string' || !recoveryCode.trim()) {
      const err: any = new Error('INVALID_RECOVERY_CODE: Please enter a valid Recovery Code');
      err.status = 400;
      err.code = 'INVALID_RECOVERY_CODE';
      err.errorMr = 'कृपया वैध रिकव्हरी कोड प्रविष्ट करा';
      throw err;
    }

    const now = Date.now();
    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;

    // Generic response if account is not found to prevent mobile enumeration,
    // while consistently enforcing rate-limiting and 24-hour lockout on the account identifier
    if (!user) {
      const record = unregisteredRecoveryAttempts.get(normalizedMobile) || { attempts: 0, lockedUntil: null };
      if (record.lockedUntil) {
        const lockExpiry = new Date(record.lockedUntil).getTime();
        if (lockExpiry > now) {
          const remainingHours = Math.ceil((lockExpiry - now) / (3600 * 1000));
          const err: any = new Error(
            `RECOVERY_LOCKED: Account recovery is locked for 24 hours due to 4 failed attempts. Try again in ${remainingHours} hours.`
          );
          err.status = 423;
          err.code = 'RECOVERY_LOCKED';
          err.retryAfter = record.lockedUntil;
          err.errorMr = `४ अयशस्वी प्रयत्नांमुळे खाते रिकव्हरी २४ तासांसाठी बंद केली आहे. कृपया ${remainingHours} तासांनंतर प्रयत्न करा.`;
          throw err;
        } else {
          record.attempts = 0;
          record.lockedUntil = null;
        }
      }

      const newAttempts = record.attempts + 1;
      if (newAttempts >= config.recoveryMaxAttempts) {
        record.attempts = newAttempts;
        record.lockedUntil = new Date(now + config.recoveryLockoutHours * 3600 * 1000).toISOString();
        unregisteredRecoveryAttempts.set(normalizedMobile, record);

        const err: any = new Error(
          `RECOVERY_LOCKED: Maximum ${config.recoveryMaxAttempts} failed attempts reached. Account recovery is locked for 24 hours.`
        );
        err.status = 423;
        err.code = 'RECOVERY_LOCKED';
        err.retryAfter = record.lockedUntil;
        err.errorMr = 'कमाल ४ अयशस्वी प्रयत्न झाले आहेत. खाते रिकव्हरी २४ तासांसाठी बंद केली आहे.';
        throw err;
      }

      record.attempts = newAttempts;
      unregisteredRecoveryAttempts.set(normalizedMobile, record);
      const remaining = config.recoveryMaxAttempts - newAttempts;
      const err: any = new Error(
        `INVALID_RECOVERY_CODE: Invalid mobile number or Recovery Code. You have ${remaining} attempt(s) remaining.`
      );
      err.status = 400;
      err.code = 'INVALID_RECOVERY_CODE';
      err.remainingAttempts = remaining;
      err.errorMr = `अवैध रिकव्हरी कोड. आपले ${remaining} प्रयत्न शिल्लक आहेत.`;
      throw err;
    }

    // Query active recovery code
    const activeCode = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ? AND status = ?').get(user.id, 'ACTIVE') as RecoveryCodeRecord | undefined;

    // Query active approved recovery request
    const approvedRequest = db.prepare(`
      SELECT * FROM recovery_requests 
      WHERE (user_id = ? OR mobile_number = ?) AND status = 'APPROVED' AND expires_at > ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(user.id, normalizedMobile, new Date(now).toISOString()) as RecoveryRequestRecord | undefined;

    // Check 24-hour lockout status on activeCode
    if (activeCode && activeCode.locked_until) {
      const lockExpiry = new Date(activeCode.locked_until).getTime();
      if (lockExpiry > now) {
        const remainingHours = Math.ceil((lockExpiry - now) / (3600 * 1000));
        const err: any = new Error(
          `RECOVERY_LOCKED: Account recovery is locked for 24 hours due to 4 failed attempts. Try again in ${remainingHours} hours.`
        );
        err.status = 423;
        err.code = 'RECOVERY_LOCKED';
        err.retryAfter = activeCode.locked_until;
        err.errorMr = `४ अयशस्वी प्रयत्नांमुळे खाते रिकव्हरी २४ तासांसाठी बंद केली आहे. कृपया ${remainingHours} तासांनंतर प्रयत्न करा.`;
        throw err;
      } else {
        db.prepare('UPDATE recovery_codes SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
          .run(new Date(now).toISOString(), activeCode.id);
        activeCode.failed_attempts = 0;
        activeCode.locked_until = null;
      }
    }

    // Check 24-hour lockout status on approvedRequest
    if (approvedRequest && approvedRequest.locked_until) {
      const lockExpiry = new Date(approvedRequest.locked_until).getTime();
      if (lockExpiry > now) {
        const remainingHours = Math.ceil((lockExpiry - now) / (3600 * 1000));
        const err: any = new Error(
          `RECOVERY_LOCKED: Account recovery is locked for 24 hours due to 4 failed attempts. Try again in ${remainingHours} hours.`
        );
        err.status = 423;
        err.code = 'RECOVERY_LOCKED';
        err.retryAfter = approvedRequest.locked_until;
        err.errorMr = `४ अयशस्वी प्रयत्नांमुळे खाते रिकव्हरी २४ तासांसाठी बंद केली आहे. कृपया ${remainingHours} तासांनंतर प्रयत्न करा.`;
        throw err;
      } else {
        db.prepare('UPDATE recovery_requests SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
          .run(new Date(now).toISOString(), approvedRequest.id);
        approvedRequest.failed_attempts = 0;
        approvedRequest.locked_until = null;
      }
    }

    // Verify recovery code: check activeCode first, then approvedRequest
    let matchedTarget: { type: 'CODE' | 'REQUEST'; id: string } | null = null;

    if (activeCode && verifyRecoveryCode(recoveryCode, activeCode.salt, activeCode.code_hash)) {
      matchedTarget = { type: 'CODE', id: activeCode.id };
    } else if (
      approvedRequest &&
      approvedRequest.approved_code_salt &&
      approvedRequest.approved_code_hash &&
      verifyRecoveryCode(recoveryCode, approvedRequest.approved_code_salt, approvedRequest.approved_code_hash)
    ) {
      matchedTarget = { type: 'REQUEST', id: approvedRequest.id };
    }

    if (!matchedTarget) {
      // Check if code was previously consumed in recovery_codes
      const consumedCodes = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ? AND status = ?').all(user.id, 'CONSUMED') as RecoveryCodeRecord[];
      for (const consumed of consumedCodes) {
        if (verifyRecoveryCode(recoveryCode, consumed.salt, consumed.code_hash)) {
          const err: any = new Error('RECOVERY_CODE_CONSUMED: This Recovery Code has already been used. A Recovery Code can be used successfully only once.');
          err.status = 400;
          err.code = 'RECOVERY_CODE_CONSUMED';
          err.errorMr = 'हा रिकव्हरी कोड आधीच वापरला गेला आहे. एक रिकव्हरी कोड फक्त एकदाच वापरता येतो.';
          throw err;
        }
      }

      // Check if consumed in recovery_requests
      const consumedRequests = db.prepare("SELECT * FROM recovery_requests WHERE (user_id = ? OR mobile_number = ?) AND status = 'CONSUMED'").all(user.id, normalizedMobile) as RecoveryRequestRecord[];
      for (const req of consumedRequests) {
        if (req.approved_code_salt && req.approved_code_hash && verifyRecoveryCode(recoveryCode, req.approved_code_salt, req.approved_code_hash)) {
          const err: any = new Error('RECOVERY_CODE_CONSUMED: This temporary Recovery Code has already been used. A Recovery Code can be used successfully only once.');
          err.status = 400;
          err.code = 'RECOVERY_CODE_CONSUMED';
          err.errorMr = 'हा तात्पुरता रिकव्हरी कोड आधीच वापरला गेला आहे. एक रिकव्हरी कोड फक्त एकदाच वापरता येतो.';
          throw err;
        }
      }

      if (!activeCode && !approvedRequest) {
        const err: any = new Error('RECOVERY_NOT_CONFIGURED: No recovery code is configured for this account. This recovery method cannot be used yet.');
        err.status = 400;
        err.code = 'RECOVERY_NOT_CONFIGURED';
        err.errorMr = 'या खात्यासाठी कोणताही रिकव्हरी कोड सेट केलेला नाही. ही पद्धत वापरता येणार नाही.';
        throw err;
      }

      let lockErr: any = null;
      let invalidErr: any = null;

      db.transaction(() => {
        let maxAttemptsReached = false;
        let remainingAttempts = config.recoveryMaxAttempts;
        const nowIso = new Date().toISOString();

        if (activeCode) {
          const currentAttempts = activeCode.failed_attempts + 1;
          let lockedUntil: string | null = null;
          if (currentAttempts >= config.recoveryMaxAttempts) {
            lockedUntil = new Date(now + config.recoveryLockoutHours * 3600 * 1000).toISOString();
            maxAttemptsReached = true;
          }
          db.prepare(`
            UPDATE recovery_codes
            SET failed_attempts = ?, locked_until = ?, updated_at = ?
            WHERE id = ?
          `).run(currentAttempts, lockedUntil, nowIso, activeCode.id);
          remainingAttempts = Math.max(0, config.recoveryMaxAttempts - currentAttempts);
        }

        if (approvedRequest) {
          const currentAttempts = approvedRequest.failed_attempts + 1;
          let lockedUntil: string | null = null;
          if (currentAttempts >= config.recoveryMaxAttempts) {
            lockedUntil = new Date(now + config.recoveryLockoutHours * 3600 * 1000).toISOString();
            maxAttemptsReached = true;
          }
          db.prepare(`
            UPDATE recovery_requests
            SET failed_attempts = ?, locked_until = ?, updated_at = ?
            WHERE id = ?
          `).run(currentAttempts, lockedUntil, nowIso, approvedRequest.id);
          remainingAttempts = Math.min(remainingAttempts, Math.max(0, config.recoveryMaxAttempts - currentAttempts));
        }

        if (maxAttemptsReached) {
          const lockedUntil = new Date(now + config.recoveryLockoutHours * 3600 * 1000).toISOString();
          const err: any = new Error(
            `RECOVERY_LOCKED: Maximum ${config.recoveryMaxAttempts} failed attempts reached. Account recovery is locked for 24 hours.`
          );
          err.status = 423;
          err.code = 'RECOVERY_LOCKED';
          err.retryAfter = lockedUntil;
          err.errorMr = 'कमाल ४ अयशस्वी प्रयत्न झाले आहेत. खाते रिकव्हरी २४ तासांसाठी बंद केली आहे.';
          lockErr = err;

          // Notify Telegram Admin of suspicious activity
          void TelegramService.notifySuspiciousRecoveryActivity({
            mobileNumber: normalizedMobile,
            failedAttempts: config.recoveryMaxAttempts,
            lockoutHours: config.recoveryLockoutHours,
            timestamp: nowIso
          }).catch(notifyErr => console.warn('[AuthService] Telegram recovery alert notice:', notifyErr?.message));
        } else {
          const err: any = new Error(
            `INVALID_RECOVERY_CODE: Invalid Recovery Code. You have ${remainingAttempts} attempt(s) remaining.`
          );
          err.status = 400;
          err.code = 'INVALID_RECOVERY_CODE';
          err.remainingAttempts = remainingAttempts;
          err.errorMr = `अवैध रिकव्हरी कोड. आपले ${remainingAttempts} प्रयत्न शिल्लक आहेत.`;
          invalidErr = err;
        }
      })();

      if (lockErr) throw lockErr;
      if (invalidErr) throw invalidErr;
    }

    // Valid code matched: Reset attempts and issue short-lived recovery authorization
    const nowIso = new Date().toISOString();
    const { rawToken, tokenHash } = generateRecoveryAuthToken();
    const authId = generateId();
    const expiresAt = new Date(now + config.recoveryAuthTtlMinutes * 60 * 1000).toISOString();

    db.transaction(() => {
      let codeIdForAuth = matchedTarget!.id;
      if (matchedTarget!.type === 'REQUEST') {
        db.prepare(`
          UPDATE recovery_requests
          SET failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE id = ?
        `).run(nowIso, matchedTarget!.id);

        const tempCodeRec = db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ?').get(user.id, approvedRequest!.approved_code_hash) as { id: string } | undefined;
        if (tempCodeRec) {
          codeIdForAuth = tempCodeRec.id;
        } else if (activeCode) {
          codeIdForAuth = activeCode.id;
        }
      } else {
        db.prepare(`
          UPDATE recovery_codes
          SET failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE id = ?
        `).run(nowIso, matchedTarget!.id);
      }

      db.prepare(`
        INSERT INTO recovery_authorizations (
          id, user_id, token_hash, recovery_code_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(authId, user.id, tokenHash, codeIdForAuth, expiresAt, nowIso);
    })();

    return {
      resetToken: rawToken,
      pinLength: (user.pin_length || 6) as (4 | 6)
    };
  }

  static resetPinWithRecoveryCode(data: {
    mobileNumber: string;
    resetToken: string;
    newPin: string;
    confirmPin?: string;
    newPinLength?: 4 | 6;
  }): { success: boolean; message: string; messageMr: string } {
    const normalizedMobile = normalizeMobileNumber(data.mobileNumber);
    if (!normalizedMobile) {
      throw new Error('INVALID_MOBILE: Please enter a valid 10-digit mobile number');
    }

    const expectedLength: 4 | 6 = data.newPinLength || (data.newPin.length === 4 ? 4 : 6);
    if (!validatePin(data.newPin, expectedLength)) {
      throw new Error(`INVALID_PIN: New PIN must be exactly ${expectedLength} digits`);
    }

    if (data.confirmPin !== undefined && data.confirmPin !== data.newPin) {
      const err: any = new Error('PIN_MISMATCH: New PIN and confirmation PIN do not match');
      err.status = 400;
      err.code = 'PIN_MISMATCH';
      err.errorMr = 'नवीन पिन आणि खात्री पिन जुळत नाहीत';
      throw err;
    }

    if (!data.resetToken || typeof data.resetToken !== 'string') {
      const err: any = new Error('UNAUTHORIZED_RESET: Missing recovery authorization token');
      err.status = 401;
      err.code = 'UNAUTHORIZED_RESET';
      err.errorMr = 'रिकव्हरी प्रमाणीकरण टोकन आवश्यक आहे';
      throw err;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;
    if (!user) {
      const err: any = new Error('USER_NOT_FOUND: No registered account found for this mobile number');
      err.status = 404;
      err.code = 'USER_NOT_FOUND';
      err.errorMr = 'या मोबाइल नंबरसाठी कोणतेही नोंदणीकृत खाते आढळले नाही';
      throw err;
    }

    const tokenHash = hashToken(data.resetToken);
    const nowIso = new Date().toISOString();
    const { hash, salt } = hashPin(data.newPin);

    db.transaction(() => {
      // 1. Verify recovery authorization token under transaction lock (protects against race conditions)
      const authRecord = db.prepare(`
        SELECT * FROM recovery_authorizations
        WHERE token_hash = ? AND user_id = ? AND expires_at > ? AND consumed_at IS NULL
      `).get(tokenHash, user.id, nowIso) as RecoveryAuthorizationRecord | undefined;

      if (!authRecord) {
        const err: any = new Error('UNAUTHORIZED_RESET: Recovery authorization is invalid or has expired. Please verify your Recovery Code again.');
        err.status = 401;
        err.code = 'UNAUTHORIZED_RESET';
        err.errorMr = 'रिकव्हरी प्रमाणीकरण अवैध आहे किंवा कालबाह्य झाले आहे. कृपया पुन्हा रिकव्हरी कोड पडताळा.';
        throw err;
      }

      // 2. Update user PIN, pin_length, reset login failures & lockout
      db.prepare(`
        UPDATE users
        SET pin_hash = ?, salt = ?, pin_length = ?, failed_login_attempts = 0, locked_until = NULL, lock_type = NULL, lock_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(hash, salt, expectedLength, nowIso, user.id);

      // 3. Mark recovery authorization as consumed
      db.prepare(`
        UPDATE recovery_authorizations
        SET consumed_at = ?
        WHERE id = ?
      `).run(nowIso, authRecord.id);

      // 4. Mark recovery code and approved recovery requests as CONSUMED (single use only)
      db.prepare(`
        UPDATE recovery_codes
        SET status = 'CONSUMED', consumed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, authRecord.recovery_code_id);

      db.prepare(`
        UPDATE recovery_requests
        SET status = 'CONSUMED', completed_at = ?, approved_code_encrypted = NULL, approved_code_iv = NULL, approved_code_tag = NULL, updated_at = ?
        WHERE (user_id = ? OR mobile_number = ? OR id = ?) AND status = 'APPROVED'
      `).run(nowIso, nowIso, user.id, user.mobile_number, authRecord.recovery_code_id);

      AdminService.logAudit({
        adminUserId: user.id,
        action: 'RECOVERY_CODE_CONSUMED',
        targetAccountId: user.id,
        targetMobileNumber: user.mobile_number,
        details: { recoveryCodeId: authRecord.recovery_code_id }
      });

      // 5. Invalidate all active sessions for this user
      db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(user.id);
    })();

    // Notify Telegram Admin asynchronously
    void TelegramService.notifyPinResetSuccess({
      mobileNumber: normalizedMobile,
      fullName: user.full_name || null,
      method: 'RECOVERY_CODE',
      timestamp: nowIso
    }).catch(err => console.warn('[AuthService] Telegram recovery reset notice:', err?.message));

    return {
      success: true,
      message: 'PIN has been reset successfully. Please log in with your new PIN.',
      messageMr: 'पिन यशस्वीरित्या बदलला आहे. कृपया नवीन पिनने लॉगिन करा.'
    };
  }

  /**
   * Authoritative bilingual dictionary for security reason messages.
   * Strictly supports English and Marathi only (Zero Hindi).
   */
  static getSecurityReasonMessage(code: string, lang: 'en' | 'mr' = 'en'): string {
    const isMr = lang === 'mr';
    switch (code) {
      case 'INCORRECT_PIN':
        return isMr
          ? 'चुकीचा पिन. आपल्याकडे {remainingAttempts} प्रयत्न शिल्लक आहेत.'
          : 'Incorrect PIN. You have {remainingAttempts} attempts remaining.';
      case 'ACCOUNT_LOCKED':
      case 'ACCOUNT_LOCKED_PIN_ATTEMPTS':
        return isMr
          ? 'वारंवार चुकीचा पिन प्रविष्ट केल्यामुळे खाते तात्पुरते कुलूपबंद (लॉक) केले गेले आहे. कृपया पुनर्सक्रियीकरणाची विनंती करा किंवा प्रशासकाशी संपर्क साधा.'
          : 'Account temporarily locked due to multiple failed PIN attempts. Please request reactivation or contact the administrator.';
      case 'ACCOUNT_LOCKED_SECURITY_REVIEW':
        return isMr
          ? 'सुरक्षा पुनरावलोकनासाठी खाते तात्पुरते कुलूपबंद (लॉक) केले गेले आहे. कृपया पुनर्सक्रियीकरणाची विनंती करा किंवा प्रशासकाशी संपर्क साधा.'
          : 'Account temporarily locked for security review. Please request reactivation or contact the administrator.';
      case 'UNAUTHORIZED_ACTION':
        return isMr
          ? 'कृतीस परवानगी नाही. आपल्याला ही कृती करण्याची परवानगी नाही.'
          : 'Action not permitted. You do not have permission to perform this operation.';
      case 'SESSION_EXPIRED':
        return isMr
          ? 'आपले सत्र संपले आहे. पुढे चालू ठेवण्यासाठी कृपया पुन्हा साइन इन करा.'
          : 'Your session has expired. Please sign in again to continue.';
      case 'SESSION_REVOKED_SECURITY':
        return isMr
          ? 'सुरक्षेच्या कारणास्तव आपले सत्र समाप्त करण्यात आले आहे. कृपया आपल्या वैध पिनसह पुन्हा साइन इन करा.'
          : 'Your session was ended for security reasons. Please sign in again with your valid PIN.';
      case 'RECOVERY_TEMPORARILY_RESTRICTED':
        return isMr
          ? 'वारंवार प्रयत्नांमुळे खाते पुनर्प्राप्ती तात्पुरती प्रतिबंधित केली गेली आहे. कृपया २४ तासांनंतर पुन्हा प्रयत्न करा किंवा प्रशासकाशी संपर्क साधा.'
          : 'Account recovery is temporarily restricted due to repeated attempts. Please try again after 24 hours or contact the administrator.';
      case 'REACTIVATION_REQUIRED':
        return isMr
          ? 'हे खाते कुलूपबंद किंवा निष्क्रिय आहे. साइन इन करण्यापूर्वी मंजूर पुनर्सक्रियीकरण विनंती आवश्यक आहे.'
          : 'This account is locked or deactivated. An approved reactivation request is required before signing in.';
      default:
        return isMr ? 'सुरक्षा त्रुटी आढळली.' : 'A security restriction was encountered.';
    }
  }
}

