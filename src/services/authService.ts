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
import { config } from '../config.js';
import type { User, SafeUser, RecoveryCodeRecord, RecoveryAuthorizationRecord, RecoveryRequestRecord } from '../types/index.js';

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

    return { user: safeUser, token: rawToken, recoveryCode };
  }

  static login(data: {
    mobileNumber: string;
    pin: string;
    deviceInfo?: string;
  }): { user: SafeUser; token: string } {
    const normalizedMobile = normalizeMobileNumber(data.mobileNumber);
    if (!normalizedMobile || !validatePin(data.pin)) {
      throw new Error('INVALID_CREDENTIALS: Invalid mobile number or PIN');
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;

    if (!user) {
      // Prevent user enumeration by returning generic error
      throw new Error('INVALID_CREDENTIALS: Invalid mobile number or PIN');
    }

    const now = new Date();

    // Check account lockout
    if (user.locked_until) {
      const lockExpiry = new Date(user.locked_until);
      if (lockExpiry > now) {
        const remainingMinutes = Math.ceil((lockExpiry.getTime() - now.getTime()) / (60 * 1000));
        if (remainingMinutes > 24 * 60) {
          throw new Error('ACCOUNT_LOCKED: Account is administratively locked. Please contact the administrator.');
        }
        throw new Error(`ACCOUNT_LOCKED: Account is temporarily locked. Try again in ${remainingMinutes} minutes.`);
      }
    }

    // Verify PIN length consistency if recorded on user
    const userPinLength = user.pin_length || 6;
    if (data.pin.length !== userPinLength) {
      // Increment failed attempts
      const newAttempts = user.failed_login_attempts + 1;
      let lockedUntil: string | null = null;
      if (newAttempts >= config.maxFailedAttempts) {
        lockedUntil = new Date(now.getTime() + config.lockoutMinutes * 60 * 1000).toISOString();
      }
      db.prepare(`
        UPDATE users
        SET failed_login_attempts = ?, locked_until = ?, updated_at = ?
        WHERE id = ?
      `).run(newAttempts, lockedUntil, now.toISOString(), user.id);
      throw new Error('INVALID_CREDENTIALS: Invalid mobile number or PIN');
    }

    // Verify PIN
    const isValid = verifyPin(data.pin, user.salt, user.pin_hash);

    if (!isValid) {
      const newAttempts = user.failed_login_attempts + 1;
      let lockedUntil: string | null = null;

      if (newAttempts >= config.maxFailedAttempts) {
        lockedUntil = new Date(now.getTime() + config.lockoutMinutes * 60 * 1000).toISOString();
      }

      db.prepare(`
        UPDATE users
        SET failed_login_attempts = ?, locked_until = ?, updated_at = ?
        WHERE id = ?
      `).run(newAttempts, lockedUntil, now.toISOString(), user.id);

      if (lockedUntil) {
        throw new Error(`ACCOUNT_LOCKED: Too many failed attempts. Account locked for ${config.lockoutMinutes} minutes.`);
      }

      throw new Error('INVALID_CREDENTIALS: Invalid mobile number or PIN');
    }

    // Successful login: reset attempts, clear lock, and record genuine last_login_at
    const loginIso = now.toISOString();
    db.prepare(`
      UPDATE users
      SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
      WHERE id = ?
    `).run(loginIso, loginIso, user.id);

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

      // Invalidate all existing sessions so old sessions cannot be hijacked
      db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(userId);
    })();

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
        SET pin_hash = ?, salt = ?, pin_length = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(hash, salt, expectedLength, now, user.id);

      // Invalidate all active sessions for this user
      db.prepare('DELETE FROM authentication_sessions WHERE user_id = ?').run(user.id);
    })();

    return {
      success: true,
      message: 'PIN has been reset successfully. Please log in with your new PIN.',
      messageMr: 'पिन यशस्वीरित्या बदलला आहे. कृपया नवीन पिनने लॉगिन करा.'
    };
  }

  static verifySession(token: string): SafeUser | null {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const db = getDatabase();
    const now = new Date().toISOString();

    const row = db.prepare(`
      SELECT s.id as session_id, u.*
      FROM authentication_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, now) as (User & { session_id: string }) | undefined;

    if (!row) return null;

    // Reject session if account is locked
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      return null;
    }

    // Update last_active_at
    db.prepare('UPDATE authentication_sessions SET last_active_at = ? WHERE id = ?').run(now, row.session_id);

    return {
      id: row.id,
      mobile_number: row.mobile_number,
      full_name: row.full_name,
      preferred_language: row.preferred_language,
      failed_login_attempts: row.failed_login_attempts,
      locked_until: row.locked_until,
      pin_length: row.pin_length || 6,
      role: (row.role || 'user') as 'user' | 'admin',
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  static generateRecoveryCodeForUser(userId: string): { recoveryCode: string; isReplacement: boolean } {
    const db = getDatabase();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
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
        SET pin_hash = ?, salt = ?, pin_length = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = ?
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

    return {
      success: true,
      message: 'PIN has been reset successfully. Please log in with your new PIN.',
      messageMr: 'पिन यशस्वीरित्या बदलला आहे. कृपया नवीन पिनने लॉगिन करा.'
    };
  }
}

