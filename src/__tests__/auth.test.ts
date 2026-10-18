import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { AuthService } from '../services/authService.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { verifyPin } from '../utils/crypto.js';
import type { User } from '../types/index.js';

describe('Authentication & Security', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterAll(() => {
    closeDatabase();
  });

  it('registers a new user and normalizes Indian mobile numbers', () => {
    const res = AuthService.register({
      mobileNumber: '+91 98765 43210',
      pin: '123456',
      fullName: 'Santosh Koli',
      preferredLanguage: 'mr'
    });

    expect(res.user.mobile_number).toBe('9876543210');
    expect(res.user.full_name).toBe('Santosh Koli');
    expect(res.user.preferred_language).toBe('mr');
    expect(res.token).toBeDefined();

    // Verify plaintext PIN is NEVER stored in database
    const db = getDatabase();
    const dbUser = db.prepare('SELECT * FROM users WHERE id = ?').get(res.user.id) as User;
    expect(dbUser.pin_hash).not.toBe('123456');
    expect(dbUser.pin_hash.length).toBe(128); // 64 bytes hex
    expect(dbUser.salt.length).toBe(64); // 32 bytes hex
    expect(verifyPin('123456', dbUser.salt, dbUser.pin_hash)).toBe(true);
  });

  it('rejects duplicate mobile number registration', () => {
    AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'User 1'
    });

    expect(() => {
      AuthService.register({
        mobileNumber: '+919876543210',
        pin: '654321',
        fullName: 'User 2'
      });
    }).toThrow('USER_EXISTS');
  });

  it('enforces 6-digit numeric PIN requirement', () => {
    expect(() => {
      AuthService.register({
        mobileNumber: '9876543210',
        pin: '12345', // only 5 digits
        fullName: 'Short PIN'
      });
    }).toThrow('INVALID_PIN');

    expect(() => {
      AuthService.register({
        mobileNumber: '9876543210',
        pin: '1234567', // 7 digits
        fullName: 'Long PIN'
      });
    }).toThrow('INVALID_PIN');

    expect(() => {
      AuthService.register({
        mobileNumber: '9876543210',
        pin: 'abcdef', // non-numeric
        fullName: 'Alpha PIN'
      });
    }).toThrow('INVALID_PIN');
  });

  it('authenticates with correct credentials and creates a session', () => {
    AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Santosh Koli'
    });

    const loginRes = AuthService.login({
      mobileNumber: '09876543210',
      pin: '123456'
    });

    expect(loginRes.user.mobile_number).toBe('9876543210');
    expect(loginRes.token).toBeDefined();

    // Verify session
    const verified = AuthService.verifySession(loginRes.token);
    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(loginRes.user.id);
  });

  it('locks the account after 5 consecutive failed login attempts', () => {
    AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Target User'
    });

    // 4 failed attempts should not lock yet
    for (let i = 0; i < 4; i++) {
      expect(() => {
        AuthService.login({ mobileNumber: '9876543210', pin: '000000' });
      }).toThrow('INVALID_CREDENTIALS');
    }

    // 5th failed attempt triggers lockout
    expect(() => {
      AuthService.login({ mobileNumber: '9876543210', pin: '000000' });
    }).toThrow('ACCOUNT_LOCKED');

    // Even with the correct PIN, access is denied during lockout
    expect(() => {
      AuthService.login({ mobileNumber: '9876543210', pin: '123456' });
    }).toThrow('ACCOUNT_LOCKED');
  });

  it('allows changing PIN and revokes existing sessions', () => {
    const reg = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Santosh Koli'
    });

    // Verify old token works
    expect(AuthService.verifySession(reg.token)).not.toBeNull();

    // Change PIN to 4 digits
    AuthService.changePin(reg.user.id, '123456', '4321', 4);

    // Old session token should now be revoked
    expect(AuthService.verifySession(reg.token)).toBeNull();

    // Login with new 4-digit PIN succeeds
    const newLogin = AuthService.login({
      mobileNumber: '9876543210',
      pin: '4321'
    });
    expect(newLogin.token).toBeDefined();
    expect(newLogin.user.pin_length).toBe(4);

    // Login with old PIN fails
    expect(() => {
      AuthService.login({ mobileNumber: '9876543210', pin: '123456' });
    }).toThrow('INVALID_CREDENTIALS');
  });

  it('supports 4-digit PIN with leading zeros ("0123")', () => {
    const reg = AuthService.register({
      mobileNumber: '9876543211',
      pin: '0123',
      pinLength: 4,
      fullName: 'Zero Leader'
    });

    expect(reg.user.pin_length).toBe(4);

    // Verify leading zeros preserved and verified
    const db = getDatabase();
    const dbUser = db.prepare('SELECT * FROM users WHERE id = ?').get(reg.user.id) as User;
    expect(verifyPin('0123', dbUser.salt, dbUser.pin_hash)).toBe(true);
    // Number conversion "123" must NOT match!
    expect(verifyPin('123', dbUser.salt, dbUser.pin_hash)).toBe(false);

    // Login with exact string '0123' succeeds
    const login = AuthService.login({
      mobileNumber: '9876543211',
      pin: '0123'
    });
    expect(login.token).toBeDefined();
  });

  it('supports 6-digit PIN with leading zeros ("004567")', () => {
    const reg = AuthService.register({
      mobileNumber: '9876543212',
      pin: '004567',
      pinLength: 6,
      fullName: 'Six Digit Zero'
    });

    expect(reg.user.pin_length).toBe(6);

    const login = AuthService.login({
      mobileNumber: '9876543212',
      pin: '004567'
    });
    expect(login.token).toBeDefined();
  });

  it('rejects invalid PIN lengths (3 digits, 5 digits, 7 digits)', () => {
    expect(() => {
      AuthService.register({
        mobileNumber: '9876543213',
        pin: '123', // 3 digits
        pinLength: 4,
        fullName: 'Short'
      });
    }).toThrow('INVALID_PIN');

    expect(() => {
      AuthService.register({
        mobileNumber: '9876543213',
        pin: '12345', // 5 digits
        pinLength: 6,
        fullName: 'Five'
      });
    }).toThrow('INVALID_PIN');

    expect(() => {
      AuthService.register({
        mobileNumber: '9876543213',
        pin: '1234567', // 7 digits
        fullName: 'Seven'
      });
    }).toThrow('INVALID_PIN');
  });

  it('resets PIN using verified Firebase OTP token and revokes sessions', async () => {
    const reg = AuthService.register({
      mobileNumber: '9876543214',
      pin: '123456',
      fullName: 'OTP Reset User'
    });

    // Create a mock Firebase ID token for +919876543214
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({
      sub: 'firebase-uid-1234',
      phone_number: '+919876543214',
      exp: futureExp
    })).toString('base64url');
    const validToken = `${header}.${payload}.mockSignature`;

    // Reset PIN to 4 digits ("9988")
    const resetResult = await AuthService.resetPinWithOtp({
      mobileNumber: '9876543214',
      newPin: '9988',
      newPinLength: 4,
      firebaseIdToken: validToken
    });

    expect(resetResult.success).toBe(true);

    // Old session must be revoked
    expect(AuthService.verifySession(reg.token)).toBeNull();

    // Login with new PIN succeeds
    const newLogin = AuthService.login({
      mobileNumber: '9876543214',
      pin: '9988'
    });
    expect(newLogin.token).toBeDefined();
    expect(newLogin.user.pin_length).toBe(4);
  });

  it('rejects OTP PIN reset if token phone number belongs to another user', async () => {
    AuthService.register({
      mobileNumber: '9876543215',
      pin: '123456',
      fullName: 'User Victim'
    });

    // Token has attacker's phone number +919999999999
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({
      sub: 'firebase-uid-attacker',
      phone_number: '+919999999999',
      exp: futureExp
    })).toString('base64url');
    const attackerToken = `${header}.${payload}.mockSignature`;

    await expect(AuthService.resetPinWithOtp({
      mobileNumber: '9876543215', // Trying to reset Victim's PIN!
      newPin: '9999',
      newPinLength: 4,
      firebaseIdToken: attackerToken
    })).rejects.toThrow('UNAUTHORIZED_RESET');
  });

  it('rejects OTP PIN reset when Firebase token is expired', async () => {
    AuthService.register({
      mobileNumber: '9876543216',
      pin: '123456',
      fullName: 'Expired Token User'
    });

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const pastExp = Math.floor(Date.now() / 1000) - 300; // 5 minutes in the past
    const payload = Buffer.from(JSON.stringify({
      sub: 'firebase-uid-expired',
      phone_number: '+919876543216',
      exp: pastExp
    })).toString('base64url');
    const expiredToken = `${header}.${payload}.mockSignature`;

    await expect(AuthService.resetPinWithOtp({
      mobileNumber: '9876543216',
      newPin: '4321',
      newPinLength: 4,
      firebaseIdToken: expiredToken
    })).rejects.toThrow('TOKEN_EXPIRED');
  });
});
