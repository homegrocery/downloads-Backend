import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';

describe('Admin Account Lock & Activate Feature (Feature 1 & Feature 3)', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-account-lock');
  const testDbPath = path.resolve(testDbDir, 'account_lock_test.db');
  let app: any;

  beforeEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDbDir, { recursive: true });
    initDatabase(testDbPath);
    app = createApp();
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  it('Feature 1: getAccounts includes both has_recovery_code and has_active_recovery_code accurately without secret leaks', async () => {
    const db = getDatabase();

    // 1. Create user with recovery code (default on register)
    const userWithCode = AuthService.register({
      mobileNumber: '9822011111',
      pin: '123456',
      fullName: 'User With Code',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // 2. Create user without recovery code
    const userWithoutCode = AuthService.register({
      mobileNumber: '9822022222',
      pin: '654321',
      fullName: 'User Without Code',
      preferredLanguage: 'en',
      pinLength: 6
    });
    // Remove recovery code for user 2
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userWithoutCode.user.id);

    // 3. Query getAccounts
    const result = AdminService.getAccounts({ page: 1, limit: 10 });
    expect(result.total).toBe(2);

    const row1 = result.accounts.find(a => a.id === userWithCode.user.id);
    const row2 = result.accounts.find(a => a.id === userWithoutCode.user.id);

    expect(row1).toBeDefined();
    expect(row1!.has_recovery_code).toBe(true);
    expect(row1!.has_active_recovery_code).toBe(true);
    // Ensure no plaintext code or secret exists
    expect((row1 as any).code_hash).toBeUndefined();
    expect((row1 as any).recovery_code).toBeUndefined();
    expect((row1 as any).salt).toBeUndefined();
    expect((row1 as any).pin_hash).toBeUndefined();

    expect(row2).toBeDefined();
    expect(row2!.has_recovery_code).toBe(false);
    expect(row2!.has_active_recovery_code).toBe(false);
  });

  it('Feature 3: locks an account, invalidates sessions, and prevents login', async () => {
    const db = getDatabase();

    const user = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Test User',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // Owner admin
    const admin = AuthService.register({
      mobileNumber: '9356755100',
      pin: '999888',
      fullName: 'Santosh Koli',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.user.id);

    // Verify session works before locking
    const validSessionUser = AuthService.verifySession(user.token);
    expect(validSessionUser).not.toBeNull();
    expect(validSessionUser!.id).toBe(user.user.id);

    // Lock user account
    const lockRes = AdminService.lockAccount({
      adminUserId: admin.user.id,
      targetAccountId: user.user.id,
      reason: 'Suspicious activity report',
      ipAddress: '127.0.0.1'
    });

    expect(lockRes.success).toBe(true);
    expect(lockRes.is_locked).toBe(true);

    // Invalidate sessions check
    const sessions = db.prepare('SELECT * FROM authentication_sessions WHERE user_id = ?').all(user.user.id);
    expect(sessions.length).toBe(0);

    // Session verification must return null
    const afterLockVerify = AuthService.verifySession(user.token);
    expect(afterLockVerify).toBeNull();

    // Login attempt must fail with ACCOUNT_LOCKED
    expect(() => {
      AuthService.login({
        mobileNumber: '9876543210',
        pin: '123456'
      });
    }).toThrow(/ACCOUNT_LOCKED/);

    // Audit log recorded
    const auditLogs = AdminService.getAuditLogs({ action: 'ACCOUNT_LOCKED' });
    expect(auditLogs.total).toBe(1);
    expect(auditLogs.logs[0].target_account_id).toBe(user.user.id);
    expect(auditLogs.logs[0].target_mobile_number).toBe('9876543210');
  });

  it('Feature 3: strictly protects owner and administrator accounts from being locked', async () => {
    const db = getDatabase();

    const admin = AuthService.register({
      mobileNumber: '9356755100',
      pin: '999888',
      fullName: 'Santosh Koli',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.user.id);

    // Self lock attempt
    expect(() => {
      AdminService.lockAccount({
        adminUserId: admin.user.id,
        targetAccountId: admin.user.id
      });
    }).toThrow(/CANNOT_LOCK_SELF/);

    // Another admin attempts to lock owner
    const secondAdmin = AuthService.register({
      mobileNumber: '9888877777',
      pin: '112233',
      fullName: 'Secondary Admin',
      preferredLanguage: 'en',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(secondAdmin.user.id);

    expect(() => {
      AdminService.lockAccount({
        adminUserId: secondAdmin.user.id,
        targetAccountId: admin.user.id
      });
    }).toThrow(/CANNOT_LOCK_OWNER/);
  });

  it('Feature 3: activates a locked account and allows normal login', async () => {
    const db = getDatabase();

    const user = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Test User',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    const admin = AuthService.register({
      mobileNumber: '9356755100',
      pin: '999888',
      fullName: 'Santosh Koli',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.user.id);

    // Lock account
    AdminService.lockAccount({
      adminUserId: admin.user.id,
      targetAccountId: user.user.id
    });

    // Verify it is locked in accounts list
    let accountsRes = AdminService.getAccounts({ search: '9876543210' });
    expect(accountsRes.accounts[0].is_locked).toBe(true);

    // Activate account
    const actRes = AdminService.activateAccount({
      adminUserId: admin.user.id,
      targetAccountId: user.user.id,
      reason: 'User identity confirmed via phone call'
    });

    expect(actRes.success).toBe(true);
    expect(actRes.is_locked).toBe(false);

    // Check accounts list shows unlocked
    accountsRes = AdminService.getAccounts({ search: '9876543210' });
    expect(accountsRes.accounts[0].is_locked).toBe(false);

    // User can now log in normally
    const loginRes = AuthService.login({
      mobileNumber: '9876543210',
      pin: '123456'
    });
    expect(loginRes.token).toBeDefined();
    expect(loginRes.user.id).toBe(user.user.id);

    // Audit log recorded
    const auditLogs = AdminService.getAuditLogs({ action: 'ACCOUNT_ACTIVATED' });
    expect(auditLogs.total).toBe(1);
    expect(auditLogs.logs[0].target_account_id).toBe(user.user.id);
  });

  it('Feature 3: exposes POST /api/admin/accounts/:id/lock and activate HTTP endpoints', async () => {
    const db = getDatabase();

    const user = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Test User',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    const admin = AuthService.register({
      mobileNumber: '9356755100',
      pin: '999888',
      fullName: 'Santosh Koli',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.user.id);

    // 1. Lock via HTTP POST
    const lockHttp = await request(app)
      .post(`/api/admin/accounts/${user.user.id}/lock`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Admin panel lock test' });

    expect(lockHttp.status).toBe(200);
    expect(lockHttp.body.success).toBe(true);
    expect(lockHttp.body.data.is_locked).toBe(true);

    // 2. Activate via HTTP POST
    const actHttp = await request(app)
      .post(`/api/admin/accounts/${user.user.id}/activate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Admin panel activate test' });

    expect(actHttp.status).toBe(200);
    expect(actHttp.body.success).toBe(true);
    expect(actHttp.body.data.is_locked).toBe(false);
  });
});
