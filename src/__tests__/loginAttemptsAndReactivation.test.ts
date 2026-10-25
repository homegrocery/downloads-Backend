import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';
import { ReactivationRequestService } from '../services/reactivationRequestService.js';

describe('Login Attempts, Account Locking & Reactivation Workflow (Build 6)', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-login-attempts');
  const testDbPath = path.resolve(testDbDir, 'login_attempts_test.db');
  let app: any;

  beforeEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDbDir, { recursive: true });
    initDatabase(testDbPath);
    app = createApp();

    // Ensure owner admin user exists for test suite
    const db = getDatabase();
    const existingAdmin = db.prepare("SELECT id FROM users WHERE mobile_number = '9356755100'").get();
    if (!existingAdmin) {
      const admin = AuthService.register({
        mobileNumber: '9356755100',
        pin: '112233',
        fullName: 'Santosh Koli Owner',
        preferredLanguage: 'mr',
        pinLength: 6
      });
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.user.id);
    }
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  it('records login attempts and increments counter from 1 of 5 up to 5 of 5, then automatically locks account', async () => {
    const reg = AuthService.register({
      mobileNumber: '9822112233',
      pin: '123456',
      fullName: 'Test User',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    const userId = reg.user.id;

    // Attempts 1 to 4: Incorrect PIN with bilingual attempt counters
    for (let i = 1; i <= 4; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ mobileNumber: '9822112233', pin: '999999' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INCORRECT_PIN');
      expect(res.body.failedAttempts).toBe(i);
      expect(res.body.maxAttempts).toBe(5);
      expect(res.body.remainingAttempts).toBe(5 - i);
      expect(res.body.error).toContain(`Failed attempts: ${i} of 5`);
      expect(res.body.errorMr).toContain(`अयशस्वी प्रयत्न: ${i} पैकी ५`);
    }

    // 5th attempt: triggers lock
    const res5 = await request(app)
      .post('/api/auth/login')
      .send({ mobileNumber: '9822112233', pin: '999999' });

    expect(res5.status).toBe(423);
    expect(res5.body.success).toBe(false);
    expect(res5.body.code).toBe('ACCOUNT_LOCKED');
    expect(res5.body.failedAttempts).toBe(5);
    expect(res5.body.lockType).toBe('AUTOMATIC');
    expect(res5.body.lockReason).toContain('Too many failed login attempts');
    expect(res5.body.errorMr).toContain('५ सलग अयशस्वी प्रयत्नांनंतर');

    // 6th attempt: remains locked without incrementing counter
    const res6 = await request(app)
      .post('/api/auth/login')
      .send({ mobileNumber: '9822112233', pin: '999999' });

    expect(res6.status).toBe(423);
    expect(res6.body.code).toBe('ACCOUNT_LOCKED');
    expect(res6.body.failedAttempts).toBe(5);

    // Verify all attempts were logged in database
    const db = getDatabase();
    const attempts = db.prepare('SELECT * FROM login_attempts WHERE user_id = ? ORDER BY attempted_at ASC').all(userId) as any[];
    expect(attempts.length).toBe(6);
    expect(attempts[0].consecutive_failed_attempts).toBe(1);
    expect(attempts[3].consecutive_failed_attempts).toBe(4);
    expect(attempts[4].consecutive_failed_attempts).toBe(5);
    expect(attempts[4].lock_triggered).toBe(1);
    expect(attempts[4].lock_type).toBe('AUTOMATIC');
  });

  it('prevents user enumeration on non-existent account and does not leak attempt counts', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ mobileNumber: '9999999999', pin: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.failedAttempts).toBeUndefined();
    expect(res.body.maxAttempts).toBeUndefined();

    // Verify logged internally with outcome FAILURE and reason ACCOUNT_NOT_FOUND
    const db = getDatabase();
    const attempt = db.prepare('SELECT * FROM login_attempts WHERE mobile_number = ?').get('9999999999') as any;
    expect(attempt).toBeDefined();
    expect(attempt.user_id).toBeNull();
    expect(attempt.reason).toBe('ACCOUNT_NOT_FOUND');
    expect(attempt.consecutive_failed_attempts).toBe(0);
  });

  it('resets failed attempt counter on successful login and logs SUCCESS', async () => {
    AuthService.register({
      mobileNumber: '9822334455',
      pin: '123456',
      fullName: 'Successful User',
      preferredLanguage: 'en',
      pinLength: 6
    });

    // 2 failed attempts
    await request(app).post('/api/auth/login').send({ mobileNumber: '9822334455', pin: '000000' });
    await request(app).post('/api/auth/login').send({ mobileNumber: '9822334455', pin: '000000' });

    // 1 successful attempt
    const res = await request(app).post('/api/auth/login').send({ mobileNumber: '9822334455', pin: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get('9822334455') as any;
    expect(user.failed_login_attempts).toBe(0);
    expect(user.locked_until).toBeNull();

    const attempts = db.prepare('SELECT * FROM login_attempts WHERE mobile_number = ? ORDER BY attempted_at DESC').all('9822334455') as any[];
    expect(attempts[0].outcome).toBe('SUCCESS');
    expect(attempts[0].reason).toBe('SUCCESS');
    expect(attempts[0].consecutive_failed_attempts).toBe(0);
  });

  it('owner admin account (9356755100) is protected from lockout', async () => {
    const db = getDatabase();
    // Update owner admin PIN
    const admin = db.prepare("SELECT * FROM users WHERE mobile_number = '9356755100'").get() as any;
    expect(admin).toBeDefined();

    // 6 failed attempts for owner admin
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ mobileNumber: '9356755100', pin: '000000' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INCORRECT_PIN');
    }

    const updatedAdmin = db.prepare("SELECT * FROM users WHERE mobile_number = '9356755100'").get() as any;
    expect(updatedAdmin.locked_until).toBeNull();
  });

  it('full reactivation request workflow: user submits, checks status, admin approves, account unlocked', async () => {
    const reg = AuthService.register({
      mobileNumber: '9822778899',
      pin: '123456',
      fullName: 'Locked User',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // Lock user by 5 failures
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ mobileNumber: '9822778899', pin: '999999' });
    }

    // 1. Submit reactivation request
    const reqRes = await request(app)
      .post('/api/reactivation-requests')
      .send({
        mobileNumber: '9822778899',
        reason: 'I forgot my PIN, please unlock my account.'
      });
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.success).toBe(true);
    expect(reqRes.body.data.request.status).toBe('PENDING');
    const requestId = reqRes.body.data.request.id;

    // 2. Reject duplicate submission while pending
    const dupRes = await request(app)
      .post('/api/reactivation-requests')
      .send({
        mobileNumber: '9822778899',
        reason: 'Another duplicate request'
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.code).toBe('DUPLICATE_REQUEST');

    // 3. Status endpoint returns pending request
    const statusRes = await request(app)
      .get('/api/reactivation-requests/status')
      .query({ mobileNumber: '9822778899' });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.hasRequest).toBe(true);
    expect(statusRes.body.data.request.status).toBe('PENDING');

    // 4. Admin approves request
    const adminLogin = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '112233' });
    const adminToken = adminLogin.body.data.token;

    const approveRes = await request(app)
      .post(`/api/admin/reactivation-requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'Verified identity over phone call' });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.data.request.status).toBe('APPROVED');

    // 5. Account is now unlocked and can log in with correct PIN
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ mobileNumber: '9822778899', pin: '123456' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);
  });

  it('admin manual account lock requires reason, saves ADMINISTRATIVE type, and invalidates sessions immediately', async () => {
    const reg = AuthService.register({
      mobileNumber: '9822998877',
      pin: '123456',
      fullName: 'Active User',
      preferredLanguage: 'en',
      pinLength: 6
    });
    const userToken = reg.token;
    const userId = reg.user.id;

    const adminLogin = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '112233' });
    const adminToken = adminLogin.body.data.token;

    // Fail if reason is empty
    const failLock = await request(app)
      .post(`/api/admin/accounts/${userId}/lock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '   ' });
    expect(failLock.status).toBe(400);
    expect(failLock.body.code).toBe('REASON_REQUIRED');

    // Succeed with valid reason
    const lockRes = await request(app)
      .post(`/api/admin/accounts/${userId}/lock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Suspicious suspicious activity detected' });
    expect(lockRes.status).toBe(200);
    expect(lockRes.body.data.is_locked).toBe(true);

    // Active session immediately rejected (401)
    const sessionRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${userToken}`);
    expect(sessionRes.status).toBe(401);

    // Subsequent login returns 423 with lock_type ADMINISTRATIVE and the specific reason
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ mobileNumber: '9822998877', pin: '123456' });
    expect(loginRes.status).toBe(423);
    expect(loginRes.body.lockType).toBe('ADMINISTRATIVE');
    expect(loginRes.body.lockReason).toBe('Suspicious suspicious activity detected');
  });

  it('admin can reject reactivation request and account remains locked', async () => {
    const reg = AuthService.register({
      mobileNumber: '9822665544',
      pin: '123456',
      fullName: 'Rejected User',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // Lock user
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ mobileNumber: '9822665544', pin: '999999' });
    }

    // Submit request
    const reqRes = await request(app)
      .post('/api/reactivation-requests')
      .send({ mobileNumber: '9822665544', reason: 'Please unlock' });
    const requestId = reqRes.body.data.request.id;

    // Admin rejects
    const adminLogin = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '112233' });
    const adminToken = adminLogin.body.data.token;

    const rejectRes = await request(app)
      .post(`/api/admin/reactivation-requests/${requestId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Failed security verification check' });

    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.request.status).toBe('REJECTED');

    // Account remains locked
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ mobileNumber: '9822665544', pin: '123456' });
    expect(loginRes.status).toBe(423);
  });
});
