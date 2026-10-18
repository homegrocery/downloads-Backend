import crypto from 'node:crypto';
import { getDatabase } from '../db/database.js';
import { generateId, hashToken, decryptTemporaryCode } from '../utils/crypto.js';
import { normalizeMobileNumber } from '../utils/validation.js';
import type { RecoveryRequestRecord, User } from '../types/index.js';
import { AdminService } from './adminService.js';

export class RecoveryRequestService {
  /**
   * Submit an Admin Recovery Request.
   * Generates a request-specific capability token stored client-side.
   */
  static createRequest(params: {
    mobileNumber: string;
    ipAddress?: string;
  }): { requestId: string; requestToken: string; status: string } {
    const normalizedMobile = normalizeMobileNumber(params.mobileNumber);
    if (!normalizedMobile) {
      const err: any = new Error('INVALID_MOBILE: Please enter a valid 10-digit mobile number');
      err.status = 400;
      err.code = 'INVALID_MOBILE';
      err.errorMr = 'कृपया वैध १०-अंकी मोबाईल नंबर प्रविष्ट करा';
      throw err;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT id, mobile_number, full_name, pin_length FROM users WHERE mobile_number = ?').get(normalizedMobile) as User | undefined;

    // Generate capability token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresIso = new Date(now + 24 * 3600 * 1000).toISOString(); // 24 hours for review

    // Anti-flooding: Check if an active PENDING request already exists
    const existingPending = db.prepare(`
      SELECT * FROM recovery_requests 
      WHERE mobile_number = ? AND status = 'PENDING'
    `).get(normalizedMobile) as RecoveryRequestRecord | undefined;

    let requestId: string;

    if (existingPending) {
      // Refresh capability token for the requester
      requestId = existingPending.id;
      db.prepare(`
        UPDATE recovery_requests 
        SET request_token_hash = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(tokenHash, expiresIso, nowIso, requestId);
    } else {
      requestId = generateId();
      db.prepare(`
        INSERT INTO recovery_requests (
          id, user_id, mobile_number, request_token_hash, status,
          failed_attempts, locked_until, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'PENDING', 0, NULL, ?, ?, ?)
      `).run(
        requestId,
        user ? user.id : null,
        normalizedMobile,
        tokenHash,
        expiresIso,
        nowIso,
        nowIso
      );
    }

    AdminService.logAudit({
      adminUserId: user ? user.id : 'ANONYMOUS_REQUESTER',
      action: 'RECOVERY_REQUEST_SUBMITTED',
      targetAccountId: user ? user.id : null,
      targetMobileNumber: normalizedMobile,
      details: { requestId },
      ipAddress: params.ipAddress
    });

    return {
      requestId,
      requestToken: rawToken,
      status: 'PENDING'
    };
  }

  /**
   * Get request status using request ID and capability token.
   * Only returns the temporary code if APPROVED and unexpired.
   */
  static getRequestStatus(requestId: string, requestToken: string): {
    status: string;
    expiresAt?: string;
    approvedCode?: string;
    pinLength?: 4 | 6;
    message?: string;
    messageMr?: string;
  } {
    if (!requestId || !requestToken) {
      const err: any = new Error('TOKEN_REQUIRED: Request ID and capability token are required');
      err.status = 401;
      err.code = 'TOKEN_REQUIRED';
      err.errorMr = 'रिकव्हरी विनंती आयडी आणि टोकन आवश्यक आहे';
      throw err;
    }

    const tokenHash = hashToken(requestToken.trim());
    const db = getDatabase();
    const reqRecord = db.prepare(`
      SELECT * FROM recovery_requests WHERE id = ? AND request_token_hash = ?
    `).get(requestId.trim(), tokenHash) as RecoveryRequestRecord | undefined;

    if (!reqRecord) {
      const err: any = new Error('REQUEST_NOT_FOUND: Invalid or expired recovery request capability');
      err.status = 404;
      err.code = 'REQUEST_NOT_FOUND';
      err.errorMr = 'रिकव्हरी विनंती आढळली नाही किंवा टोकन अवैध आहे';
      throw err;
    }

    const now = Date.now();

    // Check expiration on APPROVED requests
    if (reqRecord.status === 'APPROVED') {
      if (new Date(reqRecord.expires_at).getTime() <= now) {
        // Auto-expire and wipe secret
        db.prepare(`
          UPDATE recovery_requests
          SET status = 'EXPIRED', approved_code_encrypted = NULL, approved_code_iv = NULL, approved_code_tag = NULL, updated_at = ?
          WHERE id = ?
        `).run(new Date(now).toISOString(), reqRecord.id);

        return {
          status: 'EXPIRED',
          expiresAt: reqRecord.expires_at,
          message: 'The temporary Recovery Code has expired. Please submit a new request.',
          messageMr: 'तात्पुरता रिकव्हरी कोड कालबाह्य झाला आहे. कृपया नवीन विनंती पाठवा.'
        };
      }

      // Decrypt temporary code for authorized requester
      let decryptedCode: string | undefined;
      if (reqRecord.approved_code_encrypted && reqRecord.approved_code_iv && reqRecord.approved_code_tag) {
        try {
          decryptedCode = decryptTemporaryCode(
            reqRecord.approved_code_encrypted,
            reqRecord.approved_code_iv,
            reqRecord.approved_code_tag
          );
        } catch (e: any) {
          console.error('[RecoveryRequestService] Decryption error:', e.message);
        }
      }

      let pinLength: 4 | 6 = 6;
      if (reqRecord.user_id) {
        const u = db.prepare('SELECT pin_length FROM users WHERE id = ?').get(reqRecord.user_id) as { pin_length: number } | undefined;
        if (u && (u.pin_length === 4 || u.pin_length === 6)) {
          pinLength = u.pin_length;
        }
      }

      return {
        status: 'APPROVED',
        expiresAt: reqRecord.expires_at,
        approvedCode: decryptedCode,
        pinLength,
        message: 'Your recovery request has been approved! Use the temporary Recovery Code below to reset your PIN.',
        messageMr: 'आपली रिकव्हरी विनंती मंजूर झाली आहे! नवीन पिन सेट करण्यासाठी खालील तात्पुरता कोड वापरा.'
      };
    }

    if (reqRecord.status === 'REJECTED') {
      return {
        status: 'REJECTED',
        message: reqRecord.verification_notes || 'Your recovery request was rejected by the administrator.',
        messageMr: reqRecord.verification_notes || 'आपली विनंती प्रशासकाद्वारे नाकारली गेली आहे.'
      };
    }

    if (reqRecord.status === 'CONSUMED') {
      return {
        status: 'CONSUMED',
        message: 'This recovery request has already been used to set a new PIN.',
        messageMr: 'ही रिकव्हरी विनंती आधीच नवीन पिन सेट करण्यासाठी वापरली गेली आहे.'
      };
    }

    // PENDING state
    return {
      status: 'PENDING',
      expiresAt: reqRecord.expires_at,
      message: 'Your recovery request is pending administrator review.',
      messageMr: 'आपली रिकव्हरी विनंती प्रशासकाच्या पुनरावलोकनासाठी प्रलंबित आहे.'
    };
  }

  /**
   * Cancel / delete a recovery request using capability token.
   */
  static cancelRequest(requestId: string, requestToken: string): boolean {
    const tokenHash = hashToken(requestToken.trim());
    const db = getDatabase();
    const result = db.prepare(`
      DELETE FROM recovery_requests WHERE id = ? AND request_token_hash = ?
    `).run(requestId.trim(), tokenHash);
    return result.changes > 0;
  }
}
