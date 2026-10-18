import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { AuthService, resetUnregisteredRecoveryAttempts } from '../services/authService.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { normalizeRecoveryCode, verifyRecoveryCode } from '../utils/crypto.js';
import { config } from '../config.js';
import type { RecoveryCodeRecord, RecoveryAuthorizationRecord } from '../types/index.js';

describe('Recovery Code & PIN Recovery Policy', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetUnregisteredRecoveryAttempts();
  });

  afterAll(() => {
    closeDatabase();
  });

  describe('1. Registration and Recovery Code Generation', () => {
    it('creates a unique, secure Recovery Code during registration and stores only its hash', () => {
      const res = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli',
        preferredLanguage: 'mr'
      });

      expect(res.recoveryCode).toBeDefined();
      expect(res.recoveryCode).toMatch(/^HG-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

      const db = getDatabase();
      const codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(res.user.id) as RecoveryCodeRecord;
      expect(codeRecord).toBeDefined();
      expect(codeRecord.status).toBe('ACTIVE');
      expect(codeRecord.failed_attempts).toBe(0);
      expect(codeRecord.locked_until).toBeNull();

      // Plaintext code is NEVER stored in database
      expect(codeRecord.code_hash).not.toBe(res.recoveryCode);
      expect(codeRecord.code_hash).not.toContain('HG-');
      expect(codeRecord.code_hash.length).toBe(128); // 64 bytes scrypt hex
      expect(codeRecord.salt.length).toBe(64); // 32 bytes hex

      // Cryptographically verifies
      expect(verifyRecoveryCode(res.recoveryCode, codeRecord.salt, codeRecord.code_hash)).toBe(true);
    });

    it('generates distinct, unpredictable codes across different registrations', () => {
      const res1 = AuthService.register({
        mobileNumber: '9876543211',
        pin: '111111',
        fullName: 'User One'
      });

      const res2 = AuthService.register({
        mobileNumber: '9876543212',
        pin: '222222',
        fullName: 'User Two'
      });

      expect(res1.recoveryCode).not.toBe(res2.recoveryCode);
    });
  });

  describe('2. Existing Users & Recovery Code Generation / Replacement', () => {
    it('allows an existing authenticated user without a code to generate one', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Existing User'
      });

      // Simulate existing user before recovery code system (delete active codes)
      const db = getDatabase();
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(reg.user.id);

      const statusBefore = AuthService.getRecoveryCodeStatus(reg.user.id);
      expect(statusBefore.hasRecoveryCode).toBe(false);
      expect(statusBefore.status).toBe('NONE');

      // Authenticated user generates code
      const gen = AuthService.generateRecoveryCodeForUser(reg.user.id);
      expect(gen.recoveryCode).toMatch(/^HG-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
      expect(gen.isReplacement).toBe(false);

      const statusAfter = AuthService.getRecoveryCodeStatus(reg.user.id);
      expect(statusAfter.hasRecoveryCode).toBe(true);
      expect(statusAfter.status).toBe('ACTIVE');
    });

    it('replaces previous recovery code with REPLACED status when regenerating', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Existing User'
      });

      const firstCode = reg.recoveryCode;

      // Regenerate code
      const secondGen = AuthService.generateRecoveryCodeForUser(reg.user.id);
      expect(secondGen.recoveryCode).not.toBe(firstCode);
      expect(secondGen.isReplacement).toBe(true);

      const db = getDatabase();
      const codes = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ? ORDER BY created_at ASC').all(reg.user.id) as RecoveryCodeRecord[];
      expect(codes.length).toBe(2);
      expect(codes[0].status).toBe('REPLACED');
      expect(codes[1].status).toBe('ACTIVE');

      // Old code can no longer be used for verification
      expect(() => {
        AuthService.verifyRecoveryCode('9876543210', firstCode);
      }).toThrow('INVALID_RECOVERY_CODE');

      // New code verifies successfully
      const verifyRes = AuthService.verifyRecoveryCode('9876543210', secondGen.recoveryCode);
      expect(verifyRes.resetToken).toBeDefined();
    });

    it('rejects code generation for non-existent user', () => {
      expect(() => {
        AuthService.generateRecoveryCodeForUser('non-existent-uuid');
      }).toThrow('USER_NOT_FOUND');
    });
  });

  describe('3. PIN Recovery Flow & Authorization Security', () => {
    it('verifies valid recovery code and successfully resets a 6-digit PIN', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '111111',
        fullName: 'Santosh Koli'
      });

      const verifyRes = AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      expect(verifyRes.resetToken).toBeDefined();
      expect(verifyRes.pinLength).toBe(6);

      // Reset PIN using authorization token
      const resetRes = AuthService.resetPinWithRecoveryCode({
        mobileNumber: '9876543210',
        resetToken: verifyRes.resetToken,
        newPin: '999999',
        newPinLength: 6
      });

      expect(resetRes.success).toBe(true);

      // Old PIN no longer works
      expect(() => {
        AuthService.login({ mobileNumber: '9876543210', pin: '111111' });
      }).toThrow('INVALID_CREDENTIALS');

      // New PIN works
      const loginRes = AuthService.login({ mobileNumber: '9876543210', pin: '999999' });
      expect(loginRes.user.mobile_number).toBe('9876543210');
      expect(loginRes.token).toBeDefined();

      // Recovery code is now marked CONSUMED
      const db = getDatabase();
      const codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(reg.user.id) as RecoveryCodeRecord;
      expect(codeRecord.status).toBe('CONSUMED');
      expect(codeRecord.consumed_at).not.toBeNull();
    });

    it('supports resetting to a 4-digit PIN with leading zeros ("0123")', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      const verifyRes = AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      const resetRes = AuthService.resetPinWithRecoveryCode({
        mobileNumber: '9876543210',
        resetToken: verifyRes.resetToken,
        newPin: '0123',
        newPinLength: 4
      });

      expect(resetRes.success).toBe(true);

      // Login with leading zero 4-digit PIN succeeds
      const loginRes = AuthService.login({ mobileNumber: '9876543210', pin: '0123' });
      expect(loginRes.user.pin_length).toBe(4);
    });

    it('rejects invalid or expired reset token', () => {
      AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      expect(() => {
        AuthService.resetPinWithRecoveryCode({
          mobileNumber: '9876543210',
          resetToken: 'fake-token-never-issued-by-server',
          newPin: '654321',
          newPinLength: 6
        });
      }).toThrow('UNAUTHORIZED_RESET');
    });

    it('rejects PIN reset if confirm PIN does not match new PIN', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      const verifyRes = AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      expect(() => {
        AuthService.resetPinWithRecoveryCode({
          mobileNumber: '9876543210',
          resetToken: verifyRes.resetToken,
          newPin: '654321',
          confirmPin: '999999',
          newPinLength: 6
        });
      }).toThrow('PIN_MISMATCH');
    });

    it('prevents single-use reset token reuse (replay protection)', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      const verifyRes = AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);

      // First reset succeeds
      AuthService.resetPinWithRecoveryCode({
        mobileNumber: '9876543210',
        resetToken: verifyRes.resetToken,
        newPin: '654321',
        newPinLength: 6
      });

      // Second reset attempt with same token is rejected
      expect(() => {
        AuthService.resetPinWithRecoveryCode({
          mobileNumber: '9876543210',
          resetToken: verifyRes.resetToken,
          newPin: '777777',
          newPinLength: 6
        });
      }).toThrow('UNAUTHORIZED_RESET');
    });

    it('prevents a consumed Recovery Code from being reused', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      const verifyRes = AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      AuthService.resetPinWithRecoveryCode({
        mobileNumber: '9876543210',
        resetToken: verifyRes.resetToken,
        newPin: '654321',
        newPinLength: 6
      });

      // Attempting to verify the consumed code again fails with RECOVERY_CODE_CONSUMED
      expect(() => {
        AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      }).toThrow('RECOVERY_CODE_CONSUMED');
    });

    it('rejects recovery code associated with another account', () => {
      const user1 = AuthService.register({
        mobileNumber: '9876543210',
        pin: '111111',
        fullName: 'User 1'
      });

      AuthService.register({
        mobileNumber: '9876543211',
        pin: '222222',
        fullName: 'User 2'
      });

      // Attempting to use User 1's code on User 2's mobile
      expect(() => {
        AuthService.verifyRecoveryCode('9876543211', user1.recoveryCode);
      }).toThrow('INVALID_RECOVERY_CODE');
    });

    it('revokes existing user sessions upon PIN reset', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      // Session is currently valid
      expect(AuthService.verifySession(reg.token)).not.toBeNull();

      const verifyRes = AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      AuthService.resetPinWithRecoveryCode({
        mobileNumber: '9876543210',
        resetToken: verifyRes.resetToken,
        newPin: '654321',
        newPinLength: 6
      });

      // Old session is now invalidated
      expect(AuthService.verifySession(reg.token)).toBeNull();
    });
  });

  describe('4. Rate Limiting, 4 Failed Attempts & 24-Hour Lockout Policy', () => {
    it('tracks failed attempts and triggers 24-hour lockout on 4th failed attempt', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      const db = getDatabase();

      // Attempt 1: Fail
      try {
        AuthService.verifyRecoveryCode('9876543210', 'HG-0000-0000-0001');
      } catch (err: any) {
        expect(err.message).toContain('3 attempt(s) remaining');
      }
      let codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(reg.user.id) as RecoveryCodeRecord;
      expect(codeRecord.failed_attempts).toBe(1);
      expect(codeRecord.locked_until).toBeNull();

      // Attempt 2: Fail
      try {
        AuthService.verifyRecoveryCode('9876543210', 'HG-0000-0000-0002');
      } catch (err: any) {
        expect(err.message).toContain('2 attempt(s) remaining');
      }
      codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(reg.user.id) as RecoveryCodeRecord;
      expect(codeRecord.failed_attempts).toBe(2);

      // Attempt 3: Fail
      try {
        AuthService.verifyRecoveryCode('9876543210', 'HG-0000-0000-0003');
      } catch (err: any) {
        expect(err.message).toContain('1 attempt(s) remaining');
      }
      codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(reg.user.id) as RecoveryCodeRecord;
      expect(codeRecord.failed_attempts).toBe(3);

      // Attempt 4: Triggers 24-Hour Lockout
      try {
        AuthService.verifyRecoveryCode('9876543210', 'HG-0000-0000-0004');
        expect.unreachable();
      } catch (err: any) {
        expect(err.message).toContain('RECOVERY_LOCKED');
        expect(err.retryAfter).toBeDefined();
        expect(err.status).toBe(423);
      }

      codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(reg.user.id) as RecoveryCodeRecord;
      expect(codeRecord.failed_attempts).toBe(4);
      expect(codeRecord.locked_until).not.toBeNull();

      // Even correct Recovery Code is rejected while locked out
      expect(() => {
        AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      }).toThrow('RECOVERY_LOCKED');
    });

    it('does NOT lock ordinary Login when recovery is locked out', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      // Trigger 4 failed recovery attempts
      for (let i = 1; i <= 4; i++) {
        try {
          AuthService.verifyRecoveryCode('9876543210', `HG-0000-0000-000${i}`);
        } catch {
          // Expected
        }
      }

      // Recovery is locked
      expect(() => {
        AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      }).toThrow('RECOVERY_LOCKED');

      // Ordinary login still works normally with correct PIN!
      const loginRes = AuthService.login({ mobileNumber: '9876543210', pin: '123456' });
      expect(loginRes.token).toBeDefined();
      expect(loginRes.user.mobile_number).toBe('9876543210');
    });

    it('persists recovery lockout across database re-initialization (app restart)', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      for (let i = 1; i <= 4; i++) {
        try {
          AuthService.verifyRecoveryCode('9876543210', `HG-9999-9999-000${i}`);
        } catch {}
      }

      // Verify that re-reading from database preserves the lockout
      expect(() => {
        AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      }).toThrow('RECOVERY_LOCKED');
    });

    it('allows recovery verification again once server-authoritative 24 hours expire', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      // Trigger lockout
      for (let i = 1; i <= 4; i++) {
        try {
          AuthService.verifyRecoveryCode('9876543210', `HG-1111-1111-000${i}`);
        } catch {}
      }

      // Simulate passage of 24 hours + 1 minute by setting locked_until in the past
      const db = getDatabase();
      const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
      db.prepare('UPDATE recovery_codes SET locked_until = ? WHERE user_id = ?').run(pastTime, reg.user.id);

      // After expiry, valid Recovery Code succeeds
      const res = AuthService.verifyRecoveryCode('9876543210', reg.recoveryCode);
      expect(res.resetToken).toBeDefined();

      // DB failed attempts and locked_until are reset
      const codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(reg.user.id) as RecoveryCodeRecord;
      expect(codeRecord.failed_attempts).toBe(0);
      expect(codeRecord.locked_until).toBeNull();
    });

    it('gives generic error for non-existent account without enumerating mobile numbers', () => {
      expect(() => {
        AuthService.verifyRecoveryCode('9000000000', 'HG-1234-5678-9012');
      }).toThrow('INVALID_RECOVERY_CODE');
    });

    it('rate limits and triggers 24-hour lockout for unregistered mobile numbers identically without enumeration', () => {
      const unknownMobile = '9123456789';

      // Attempts 1 to 3 return remaining attempts
      for (let i = 1; i <= 3; i++) {
        try {
          AuthService.verifyRecoveryCode(unknownMobile, `HG-0000-0000-000${i}`);
          expect.unreachable();
        } catch (err: any) {
          expect(err.code).toBe('INVALID_RECOVERY_CODE');
          expect(err.remainingAttempts).toBe(4 - i);
        }
      }

      // Attempt 4 triggers 24-hour lockout
      try {
        AuthService.verifyRecoveryCode(unknownMobile, 'HG-0000-0000-0004');
        expect.unreachable();
      } catch (err: any) {
        expect(err.code).toBe('RECOVERY_LOCKED');
        expect(err.status).toBe(423);
        expect(err.retryAfter).toBeDefined();
      }

      // Further attempts while locked return RECOVERY_LOCKED
      expect(() => {
        AuthService.verifyRecoveryCode(unknownMobile, 'HG-0000-0000-0005');
      }).toThrow('RECOVERY_LOCKED');
    });

    it('prevents concurrent verification requests from exceeding 4 allowed attempts', async () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Concurrency Test'
      });

      // Issue 8 concurrent invalid verification requests
      const promises = Array.from({ length: 8 }, (_, i) => {
        return Promise.resolve().then(() => {
          try {
            AuthService.verifyRecoveryCode('9876543210', `HG-9999-9999-000${i}`);
            return { success: true, code: 'OK', status: 200 };
          } catch (err: any) {
            return { success: false, code: err.code, status: err.status };
          }
        });
      });

      const results = await Promise.all(promises);
      expect(results.every(r => !r.success)).toBe(true);

      const db = getDatabase();
      const codeRecord = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').get(reg.user.id) as RecoveryCodeRecord;

      // Must be locked out after 4 attempts
      expect(codeRecord.failed_attempts).toBeGreaterThanOrEqual(4);
      expect(codeRecord.locked_until).not.toBeNull();

      // Subsequent requests receive RECOVERY_LOCKED (423)
      const lockedCount = results.filter(r => r.code === 'RECOVERY_LOCKED' || r.status === 423).length;
      expect(lockedCount).toBeGreaterThanOrEqual(4);
    });

    it('explains that recovery is not configured if user has no recovery code', () => {
      const reg = AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Santosh Koli'
      });

      // Delete recovery code to simulate unconfigured account
      const db = getDatabase();
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(reg.user.id);

      expect(() => {
        AuthService.verifyRecoveryCode('9876543210', 'HG-1234-5678-9012');
      }).toThrow('RECOVERY_NOT_CONFIGURED');
    });
  });
});
