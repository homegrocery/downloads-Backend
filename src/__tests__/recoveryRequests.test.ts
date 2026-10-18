import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';
import { RecoveryRequestService } from '../services/recoveryRequestService.js';

describe('Recovery Request Lifecycle & Temporary Code', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-recovery-req');
  const testDbPath = path.resolve(testDbDir, 'recovery_req_test.db');
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

  it('full recovery request lifecycle: submit, approve with verification, retrieve temporary code, reset PIN', async () => {
    const db = getDatabase();

    // 1. Register a user
    const userReg = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'User Who Forgot Pin',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // 2. Register owner admin
    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    // Admin login
    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const adminToken = adminLoginRes.body.data.token;

    // 3. User submits recovery request
    const reqSubmitRes = await request(app)
      .post('/api/recovery-requests')
      .send({ mobileNumber: '9876543210' });

    expect(reqSubmitRes.status).toBe(201);
    expect(reqSubmitRes.body.data.requestId).toBeDefined();
    expect(reqSubmitRes.body.data.requestToken).toBeDefined();
    expect(reqSubmitRes.body.data.status).toBe('PENDING');

    const requestId = reqSubmitRes.body.data.requestId;
    const requestToken = reqSubmitRes.body.data.requestToken;

    // 4. User polls status while still PENDING
    const initialStatusRes = await request(app)
      .get('/api/recovery-requests/status')
      .set('X-Recovery-Request-Id', requestId)
      .set('X-Recovery-Token', requestToken);

    expect(initialStatusRes.status).toBe(200);
    expect(initialStatusRes.body.data.status).toBe('PENDING');
    expect(initialStatusRes.body.data.approvedCode).toBeUndefined();

    // 5. Admin lists recovery requests queue
    const queueRes = await request(app)
      .get('/api/admin/recovery-requests')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(queueRes.status).toBe(200);
    expect(queueRes.body.data.requests.length).toBe(1);
    expect(queueRes.body.data.requests[0].id).toBe(requestId);
    expect(queueRes.body.data.requests[0].status).toBe('PENDING');

    // 6. Admin attempts to approve without independent verification method -> should be rejected
    const invalidApproveRes = await request(app)
      .post(`/api/admin/recovery-requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verificationMethod: '' });

    expect(invalidApproveRes.status).toBe(400);
    expect(invalidApproveRes.body.error).toContain('VERIFICATION_REQUIRED');

    // 7. Admin approves with valid verification method
    const approveRes = await request(app)
      .post(`/api/admin/recovery-requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        verificationMethod: 'PHONE_CALL',
        notes: 'Verified identity directly via phone call with account owner'
      });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.temporaryCode).toMatch(/^HG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const tempCodeFromAdmin = approveRes.body.data.temporaryCode;

    // 8. Requester polls status with valid capability token
    const approvedStatusRes = await request(app)
      .get('/api/recovery-requests/status')
      .set('X-Recovery-Request-Id', requestId)
      .set('X-Recovery-Token', requestToken);

    expect(approvedStatusRes.status).toBe(200);
    expect(approvedStatusRes.body.data.status).toBe('APPROVED');
    expect(approvedStatusRes.body.data.approvedCode).toBe(tempCodeFromAdmin);

    // Unauthorized query without token fails
    const badTokenRes = await request(app)
      .get('/api/recovery-requests/status')
      .set('X-Recovery-Request-Id', requestId)
      .set('X-Recovery-Token', 'invalid_token_123');

    expect(badTokenRes.status).toBe(404);

    // 9. User verifies temporary recovery code with /api/auth/verify-recovery-code
    const verifyCodeRes = await request(app)
      .post('/api/auth/verify-recovery-code')
      .send({
        mobileNumber: '9876543210',
        recoveryCode: tempCodeFromAdmin
      });

    expect(verifyCodeRes.status).toBe(200);
    expect(verifyCodeRes.body.data.resetToken).toBeDefined();
    const resetToken = verifyCodeRes.body.data.resetToken;

    // 10. User resets PIN using the resetToken
    const resetPinRes = await request(app)
      .post('/api/auth/reset-pin-recovery')
      .send({
        mobileNumber: '9876543210',
        resetToken,
        newPin: '998877',
        confirmPin: '998877',
        newPinLength: 6
      });

    expect(resetPinRes.status).toBe(200);
    expect(resetPinRes.body.success).toBe(true);

    // 11. Verify user can now log in with NEW PIN
    const newLoginRes = await request(app)
      .post('/api/auth/login')
      .send({
        mobileNumber: '9876543210',
        pin: '998877'
      });

    expect(newLoginRes.status).toBe(200);
    expect(newLoginRes.body.data.user.id).toBe(userReg.user.id);

    // Old PIN fails
    const oldLoginRes = await request(app)
      .post('/api/auth/login')
      .send({
        mobileNumber: '9876543210',
        pin: '123456'
      });
    expect(oldLoginRes.status).toBe(400);

    // 12. Re-using the same temporary code fails (single-use policy)
    const reuseVerifyRes = await request(app)
      .post('/api/auth/verify-recovery-code')
      .send({
        mobileNumber: '9876543210',
        recoveryCode: tempCodeFromAdmin
      });

    expect(reuseVerifyRes.status).toBe(400);
    expect(reuseVerifyRes.body.error).toContain('RECOVERY_CODE_CONSUMED');
  });

  it('rejects recovery request with reason and does not issue a code', async () => {
    const db = getDatabase();

    // Register user & admin
    AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Rejected Requester',
      preferredLanguage: 'en',
      pinLength: 6
    });

    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const adminToken = adminLoginRes.body.data.token;

    // Submit request
    const reqSubmitRes = await request(app)
      .post('/api/recovery-requests')
      .send({ mobileNumber: '9876543210' });
    const requestId = reqSubmitRes.body.data.requestId;
    const requestToken = reqSubmitRes.body.data.requestToken;

    // Admin rejects request
    const rejectRes = await request(app)
      .post(`/api/admin/recovery-requests/${requestId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Could not verify caller identity' });

    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.success).toBe(true);

    // Requester status check shows REJECTED
    const statusRes = await request(app)
      .get('/api/recovery-requests/status')
      .set('X-Recovery-Request-Id', requestId)
      .set('X-Recovery-Token', requestToken);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.status).toBe('REJECTED');
    expect(statusRes.body.data.approvedCode).toBeUndefined();
  });

  it('triggers 24-hour lockout after 4 consecutive failed attempts on temporary recovery code', async () => {
    const db = getDatabase();

    // Register user & admin
    AuthService.register({
      mobileNumber: '9876543212',
      pin: '123456',
      fullName: 'Lockout Target',
      preferredLanguage: 'en',
      pinLength: 6
    });

    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const adminToken = adminLoginRes.body.data.token;

    // Submit & Approve
    const reqSubmitRes = await request(app)
      .post('/api/recovery-requests')
      .send({ mobileNumber: '9876543212' });
    const requestId = reqSubmitRes.body.data.requestId;

    await request(app)
      .post(`/api/admin/recovery-requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verificationMethod: 'IN_PERSON' });

    // 4 failed verification attempts
    for (let i = 1; i <= 3; i++) {
      const failRes = await request(app)
        .post('/api/auth/verify-recovery-code')
        .send({
          mobileNumber: '9876543212',
          recoveryCode: 'HG-WRON-GCOD-E00' + i
        });
      expect(failRes.status).toBe(400);
      expect(failRes.body.error).toContain('INVALID_RECOVERY_CODE');
    }

    // 4th failed attempt triggers 24-hour lockout (status 423)
    const lockRes = await request(app)
      .post('/api/auth/verify-recovery-code')
      .send({
        mobileNumber: '9876543212',
        recoveryCode: 'HG-WRON-GCOD-E004'
      });

    expect(lockRes.status).toBe(423);
    expect(lockRes.body.error).toContain('RECOVERY_LOCKED');
  });

  it('handles expired requests safely: cannot retrieve or verify expired temporary code', async () => {
    const db = getDatabase();

    // Register user & admin
    AuthService.register({
      mobileNumber: '9876543213',
      pin: '123456',
      fullName: 'Expiring Target',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const adminToken = adminLoginRes.body.data.token;

    // Submit & Approve
    const reqSubmitRes = await request(app)
      .post('/api/recovery-requests')
      .send({ mobileNumber: '9876543213' });
    const requestId = reqSubmitRes.body.data.requestId;
    const requestToken = reqSubmitRes.body.data.requestToken;

    const approveRes = await request(app)
      .post(`/api/admin/recovery-requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verificationMethod: 'PHONE_CALL' });

    const issuedCode = approveRes.body.data.temporaryCode;

    // Simulate expiration by setting expires_at to 1 hour in the past
    const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
    db.prepare('UPDATE recovery_requests SET expires_at = ? WHERE id = ?').run(pastIso, requestId);

    // Status poll detects expiry and clears temporary code
    const statusRes = await request(app)
      .get('/api/recovery-requests/status')
      .set('X-Recovery-Request-Id', requestId)
      .set('X-Recovery-Token', requestToken);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.status).toBe('EXPIRED');
    expect(statusRes.body.data.approvedCode).toBeUndefined();

    // Attempting to verify expired code fails
    const verifyRes = await request(app)
      .post('/api/auth/verify-recovery-code')
      .send({
        mobileNumber: '9876543213',
        recoveryCode: issuedCode
      });

    expect(verifyRes.status).toBe(400);
  });
});

