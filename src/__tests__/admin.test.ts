import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';
import { config } from '../config.js';

describe('Admin ERP Authentication & Isolation', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-admin');
  const testDbPath = path.resolve(testDbDir, 'admin_test.db');
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

  it('allows owner admin to log in and forbids ordinary users from admin routes', async () => {
    const db = getDatabase();

    // 1. Create an ordinary user
    const userReg = AuthService.register({
      mobileNumber: '9123456780',
      pin: '123456',
      fullName: 'Ordinary User',
      preferredLanguage: 'en',
      pinLength: 6
    });

    // 2. Create an admin user
    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    // Set role to admin explicitly on server side
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    // Ordinary user tries to login to Admin API
    const userAdminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({
        mobileNumber: '9123456780',
        pin: '123456'
      });

    expect(userAdminLoginRes.status).toBe(403);
    expect(userAdminLoginRes.body.error).toContain('ADMIN_FORBIDDEN');

    // Ordinary user tries to access /api/admin/accounts with their user session token
    const userAccessRes = await request(app)
      .get('/api/admin/accounts')
      .set('Authorization', `Bearer ${userReg.token}`);

    expect(userAccessRes.status).toBe(403);
    expect(userAccessRes.body.error).toContain('ADMIN_FORBIDDEN');

    // Admin user logs in to Admin API
    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({
        mobileNumber: '9356755100',
        pin: '654321'
      });

    expect(adminLoginRes.status).toBe(200);
    expect(adminLoginRes.body.success).toBe(true);
    expect(adminLoginRes.body.data.user.role).toBe('admin');
    const adminToken = adminLoginRes.body.data.token;
    expect(adminToken).toBeDefined();

    // Admin accesses /api/admin/accounts
    const accountsRes = await request(app)
      .get('/api/admin/accounts')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(accountsRes.status).toBe(200);
    expect(accountsRes.body.data.accounts.length).toBe(2);
    // Ensure metadata only: no PIN hash, no salt, no grocery lists or items
    const firstAccount = accountsRes.body.data.accounts[0];
    expect(firstAccount.pin_hash).toBeUndefined();
    expect(firstAccount.salt).toBeUndefined();
    expect(firstAccount.items).toBeUndefined();
    expect(firstAccount.shoppingLists).toBeUndefined();
    expect(firstAccount.mobile_number).toBeDefined();
    expect(firstAccount.has_recovery_code).toBe(true);
  });

  it('records audit logs for admin operations and rejected access attempts', async () => {
    const db = getDatabase();

    // Register admin user
    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    // Wrong PIN attempt on admin login
    const wrongPinRes = await request(app)
      .post('/api/admin/auth/login')
      .send({
        mobileNumber: '9356755100',
        pin: '000000'
      });

    expect(wrongPinRes.status).toBe(401);

    // Check audit logs
    const auditRows = db.prepare('SELECT * FROM admin_audit_logs').all() as any[];
    expect(auditRows.some(r => r.action === 'ADMIN_LOGIN_FAILED_WRONG_PIN')).toBe(true);
  });

  it('updates admin profile and records audit event', async () => {
    const db = getDatabase();

    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    const loginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const token = loginRes.body.data.token;

    // Ordinary user cannot update admin profile
    const ordinaryReg = AuthService.register({
      mobileNumber: '9111222333',
      pin: '123456',
      fullName: 'Ordinary User',
      preferredLanguage: 'en',
      pinLength: 6
    });

    const forbiddenRes = await request(app)
      .patch('/api/admin/profile')
      .set('Authorization', `Bearer ${ordinaryReg.token}`)
      .send({ fullName: 'Hacker Name' });
    expect(forbiddenRes.status).toBe(403);

    // Admin updates full name and preferred language
    const updateRes = await request(app)
      .patch('/api/admin/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fullName: 'Santosh Koli (Verified Owner)',
        preferredLanguage: 'en'
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.admin.full_name).toBe('Santosh Koli (Verified Owner)');
    expect(updateRes.body.data.admin.preferred_language).toBe('en');

    // Verify in database
    const dbUser = db.prepare('SELECT full_name, preferred_language, role FROM users WHERE id = ?').get(adminReg.user.id) as any;
    expect(dbUser.full_name).toBe('Santosh Koli (Verified Owner)');
    expect(dbUser.preferred_language).toBe('en');
    expect(dbUser.role).toBe('admin'); // Role preserved!

    // Verify audit log
    const auditRows = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ADMIN_PROFILE_UPDATED'").all() as any[];
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it('handles admin change PIN end-to-end with security verifications', async () => {
    const db = getDatabase();

    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    const loginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const originalToken = loginRes.body.data.token;

    // 1. Wrong current PIN is rejected
    const wrongCurrentRes = await request(app)
      .post('/api/admin/auth/change-pin')
      .set('Authorization', `Bearer ${originalToken}`)
      .send({
        currentPin: '111111',
        newPin: '987654',
        confirmPin: '987654'
      });
    expect(wrongCurrentRes.status).toBe(401);
    expect(wrongCurrentRes.body.error).toContain('INVALID_CURRENT_PIN');

    // 2. Mismatched confirm PIN is rejected
    const mismatchRes = await request(app)
      .post('/api/admin/auth/change-pin')
      .set('Authorization', `Bearer ${originalToken}`)
      .send({
        currentPin: '654321',
        newPin: '987654',
        confirmPin: '987655'
      });
    expect(mismatchRes.status).toBe(400);
    expect(mismatchRes.body.error).toContain('PIN_MISMATCH');

    // 3. Identical PIN is rejected
    const identicalRes = await request(app)
      .post('/api/admin/auth/change-pin')
      .set('Authorization', `Bearer ${originalToken}`)
      .send({
        currentPin: '654321',
        newPin: '654321',
        confirmPin: '654321'
      });
    expect(identicalRes.status).toBe(400);
    expect(identicalRes.body.error).toContain('PIN_IDENTICAL');

    // 4. Successful PIN change
    const successRes = await request(app)
      .post('/api/admin/auth/change-pin')
      .set('Authorization', `Bearer ${originalToken}`)
      .send({
        currentPin: '654321',
        newPin: '987654',
        confirmPin: '987654'
      });
    expect(successRes.status).toBe(200);
    expect(successRes.body.success).toBe(true);
    const newToken = successRes.body.data.token;
    expect(newToken).toBeDefined();

    // 5. Old session token was invalidated
    const oldSessionRes = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${originalToken}`);
    expect(oldSessionRes.status).toBe(401);

    // 6. New session token is valid
    const newSessionRes = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${newToken}`);
    expect(newSessionRes.status).toBe(200);
    expect(newSessionRes.body.data.admin.id).toBe(adminReg.user.id);

    // 7. Old PIN can NO LONGER log in
    const oldPinLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    expect(oldPinLoginRes.status).toBe(401);

    // 8. New PIN logs in successfully
    const newPinLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '987654' });
    expect(newPinLoginRes.status).toBe(200);
    expect(newPinLoginRes.body.data.user.role).toBe('admin');

    // 9. Audit log recorded ADMIN_PIN_CHANGED
    const auditRows = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ADMIN_PIN_CHANGED'").all() as any[];
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].target_mobile_number).toBe('9356755100');
  });

  it('Build 9 Phase 1.5: GET /api/admin/system/freshness returns change markers and 304 on matching ETag', async () => {
    // 1. Unauthenticated request rejected
    const unauthRes = await request(app).get('/api/admin/system/freshness');
    expect(unauthRes.status).toBe(401);

    // 2. Admin logs in
    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    const db = getDatabase();
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    const loginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const token = loginRes.body.data.token;

    // 3. Authenticated freshness call
    const freshRes1 = await request(app)
      .get('/api/admin/system/freshness')
      .set('Authorization', `Bearer ${token}`);

    expect(freshRes1.status).toBe(200);
    expect(freshRes1.body.success).toBe(true);
    expect(freshRes1.body.data.etag).toBeDefined();
    expect(freshRes1.body.data.markers).toBeDefined();
    expect(freshRes1.body.data.markers.accounts).toBeDefined();
    expect(freshRes1.body.data.summary.totalAccounts).toBeGreaterThan(0);

    const etag1 = freshRes1.body.data.etag;

    // 4. Client polls with If-None-Match: returns 304 Not Modified
    const notModRes = await request(app)
      .get('/api/admin/system/freshness')
      .set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', `"${etag1}"`);

    expect(notModRes.status).toBe(304);

    // 5. Authoritative backend data changes (e.g. new user registered)
    AuthService.register({
      mobileNumber: '9899887766',
      pin: '123456',
      fullName: 'New Customer',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // 6. Polling with old ETag detects change: returns 200 with new ETag & markers
    const freshRes2 = await request(app)
      .get('/api/admin/system/freshness')
      .set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', `"${etag1}"`);

    expect(freshRes2.status).toBe(200);
    const etag2 = freshRes2.body.data.etag;
    expect(etag2).not.toBe(etag1);
    expect(freshRes2.body.data.summary.totalAccounts).toBe(freshRes1.body.data.summary.totalAccounts + 1);
  });

  it('Build 9 Phase 2: allows Default Admin login with PIN only without sending mobile number', async () => {
    // 1. Create owner admin account
    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    const db = getDatabase();
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    // 2. Login with PIN only (no mobileNumber in body)
    const loginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ pin: '654321' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);
    expect(loginRes.body.data.token).toBeDefined();
    expect(loginRes.body.data.admin.role).toBe('admin');
    expect(loginRes.body.data.admin.id).toBe(adminReg.user.id);

    // 3. Login with wrong PIN only fails
    const wrongPinRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ pin: '000000' });

    expect(wrongPinRes.status).toBe(401);
    expect(wrongPinRes.body.success).toBe(false);

    // 4. Missing PIN rejected
    const missingPinRes = await request(app)
      .post('/api/admin/auth/login')
      .send({});

    expect(missingPinRes.status).toBe(400);
  });
});
