import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';

describe('Admin ERP — Permanent Deletion (Recovery Requests & Archived Logs)', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-perm-deletion');
  const testDbPath = path.resolve(testDbDir, 'perm_deletion_test.db');
  let app: any;
  let adminToken: string;
  let userToken: string;
  let adminId: string;
  let userId: string;

  beforeEach(async () => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDbDir, { recursive: true });
    initDatabase(testDbPath);
    app = createApp();

    const db = getDatabase();

    // 1. Create ordinary user
    const userReg = AuthService.register({
      mobileNumber: '9820027118',
      pin: '123456',
      fullName: 'Regular User',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    userId = userReg.user.id;
    const userLogin = AuthService.login({ mobileNumber: '9820027118', pin: '123456' });
    userToken = userLogin.token;

    // 2. Create owner admin
    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli (Owner)',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    adminId = adminReg.user.id;
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId);
    const adminLogin = AdminService.loginAdmin({ mobileNumber: '9356755100', pin: '654321' });
    adminToken = adminLogin.token;
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  describe('Feature A: Recovery Requests Permanent Deletion', () => {
    it('deletes a pending recovery request and preserves user account and permanent code', async () => {
      const db = getDatabase();

      // Submit recovery request
      const reqSubmitRes = await request(app)
        .post('/api/recovery-requests')
        .send({ mobileNumber: '9820027118' });
      expect(reqSubmitRes.status).toBe(201);
      const requestId = reqSubmitRes.body.data.requestId;

      // Delete request via POST /api/admin/recovery-requests/:id/delete
      const deleteRes = await request(app)
        .post(`/api/admin/recovery-requests/${requestId}/delete`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
      expect(deleteRes.body.data.id).toBe(requestId);

      // Verify request is gone from database
      const checkReq = db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(requestId);
      expect(checkReq).toBeUndefined();

      // Verify user account is completely untouched
      const checkUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      expect(checkUser).toBeDefined();

      // Verify audit log exists in active logs
      const auditLog = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'RECOVERY_REQUEST_DELETED' AND is_archived = 0").get() as any;
      expect(auditLog).toBeDefined();
      expect(JSON.parse(auditLog.details).requestId).toBe(requestId);
    });

    it('deletes an approved recovery request and revokes temporary code & authorizations', async () => {
      const db = getDatabase();

      // 1. Submit request
      const reqSubmitRes = await request(app)
        .post('/api/recovery-requests')
        .send({ mobileNumber: '9820027118' });
      const requestId = reqSubmitRes.body.data.requestId;

      // 2. Approve request
      const approveRes = await request(app)
        .post(`/api/admin/recovery-requests/${requestId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verificationMethod: 'PHONE_CALL', notes: 'Verified via voice call' });
      expect(approveRes.status).toBe(200);
      const tempCode = approveRes.body.data.temporaryCode;

      // 3. Verify that a TEMPORARY recovery code exists in DB
      const tempCodesBefore = db.prepare("SELECT * FROM recovery_codes WHERE status = 'TEMPORARY' AND user_id = ?").all(userId);
      expect(tempCodesBefore.length).toBeGreaterThan(0);

      // 4. Verify temporary recovery code to create a recovery authorization
      const verifyRes = await request(app)
        .post('/api/auth/verify-recovery-code')
        .send({ mobileNumber: '9820027118', recoveryCode: tempCode });
      expect(verifyRes.status).toBe(200);
      const resetToken = verifyRes.body.data.resetToken;
      expect(resetToken).toBeDefined();

      // Verify authorization exists
      const authsBefore = db.prepare('SELECT * FROM recovery_authorizations WHERE user_id = ?').all(userId);
      expect(authsBefore.length).toBeGreaterThan(0);

      // 5. Admin permanently deletes the approved request via DELETE /api/admin/recovery-requests/:id
      const deleteRes = await request(app)
        .delete(`/api/admin/recovery-requests/${requestId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
      expect(deleteRes.body.data.revokedAuthorizations).toBeGreaterThan(0);
      expect(deleteRes.body.data.deletedTempCodes).toBeGreaterThan(0);

      // 6. Verify request is deleted
      const checkReq = db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(requestId);
      expect(checkReq).toBeUndefined();

      // 7. Verify temporary codes are deleted
      const tempCodesAfter = db.prepare("SELECT * FROM recovery_codes WHERE status = 'TEMPORARY' AND user_id = ?").all(userId);
      expect(tempCodesAfter.length).toBe(0);

      // 8. Verify authorizations were revoked/deleted
      const authsAfter = db.prepare('SELECT * FROM recovery_authorizations WHERE user_id = ?').all(userId);
      expect(authsAfter.length).toBe(0);

      // 9. Verify user CANNOT use old resetToken anymore (returns 401 Unauthorized)
      const resetAttempt = await request(app)
        .post('/api/auth/reset-pin-recovery')
        .send({
          mobileNumber: '9820027118',
          resetToken,
          newPin: '999999'
        });
      expect(resetAttempt.status).toBe(401);

      // 10. Verify permanent user account is intact
      const checkUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      expect(checkUser).toBeDefined();
    });

    it('rejects deletion of non-existent recovery request with 404', async () => {
      const res = await request(app)
        .post('/api/admin/recovery-requests/non-existent-uuid/delete')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('REQUEST_NOT_FOUND');
    });

    it('bulk deletes all recovery requests with exact confirmation phrase', async () => {
      const db = getDatabase();

      // Create two distinct users
      AuthService.register({
        mobileNumber: '9876543210',
        pin: '123456',
        fullName: 'Second User',
        preferredLanguage: 'mr',
        pinLength: 6
      });

      // Submit recovery requests for two distinct users
      await request(app).post('/api/recovery-requests').send({ mobileNumber: '9820027118' });
      await request(app).post('/api/recovery-requests').send({ mobileNumber: '9876543210' });

      const countBefore = (db.prepare('SELECT COUNT(*) as count FROM recovery_requests').get() as any).count;
      expect(countBefore).toBe(2);

      // Test with wrong phrase -> rejected
      const wrongPhraseRes = await request(app)
        .post('/api/admin/recovery-requests/bulk-delete')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationPhrase: 'WRONG PHRASE' });
      expect(wrongPhraseRes.status).toBe(400);
      expect(wrongPhraseRes.body.code).toBe('CONFIRMATION_MISMATCH');

      // Test with exact phrase -> succeeds
      const bulkRes = await request(app)
        .post('/api/admin/recovery-requests/bulk-delete')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationPhrase: 'DELETE ALL RECOVERY REQUESTS' });

      expect(bulkRes.status).toBe(200);
      expect(bulkRes.body.success).toBe(true);
      expect(bulkRes.body.data.deletedCount).toBe(2);

      const countAfter = (db.prepare('SELECT COUNT(*) as count FROM recovery_requests').get() as any).count;
      expect(countAfter).toBe(0);

      // Active audit log recorded
      const auditLog = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'RECOVERY_REQUESTS_BULK_DELETED' AND is_archived = 0").get() as any;
      expect(auditLog).toBeDefined();
      expect(JSON.parse(auditLog.details).deletedCount).toBe(2);
    });

    it('denies ordinary users from deleting recovery requests', async () => {
      const res = await request(app)
        .post('/api/admin/recovery-requests/some-id/delete')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Feature B: Archived Logs Permanent Deletion', () => {
    it('deletes an archived log permanently and logs an active audit event', async () => {
      const db = getDatabase();

      // Create two active audit logs
      AdminService.logAudit({
        adminUserId: adminId,
        action: 'TEST_ACTION_1',
        targetMobileNumber: '9820027118'
      });
      AdminService.logAudit({
        adminUserId: adminId,
        action: 'TEST_ACTION_2',
        targetMobileNumber: '9820027118'
      });

      const log1 = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'TEST_ACTION_1'").get() as any;
      expect(log1).toBeDefined();

      // Attempting to delete active log should fail (must be archived first)
      const failActiveDelete = await request(app)
        .post(`/api/admin/audit-logs/${log1.id}/delete`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(failActiveDelete.status).toBe(400);
      expect(failActiveDelete.body.code).toBe('CANNOT_DELETE_ACTIVE_LOG');

      // Archive log1
      AdminService.archiveAuditLog({ id: log1.id, adminUserId: adminId });

      // Now delete the archived log
      const deleteRes = await request(app)
        .post(`/api/admin/audit-logs/${log1.id}/delete`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // Verify log1 is permanently removed
      const checkLog1 = db.prepare('SELECT * FROM admin_audit_logs WHERE id = ?').get(log1.id);
      expect(checkLog1).toBeUndefined();

      // Verify active log2 remains untouched
      const checkLog2 = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'TEST_ACTION_2'").get();
      expect(checkLog2).toBeDefined();

      // Verify active audit event for deletion is present
      const deletionAudit = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ARCHIVED_AUDIT_LOG_DELETED' AND is_archived = 0").get() as any;
      expect(deletionAudit).toBeDefined();
      expect(JSON.parse(deletionAudit.details).deletedLogId).toBe(log1.id);
    });

    it('bulk deletes only archived logs with exact confirmation phrase, leaving active logs intact', async () => {
      const db = getDatabase();

      // Create 3 active logs
      for (let i = 1; i <= 3; i++) {
        AdminService.logAudit({
          adminUserId: adminId,
          action: `ACTIVE_ACTION_${i}`,
          targetMobileNumber: '9820027118'
        });
      }

      // Archive 2 of them
      const logsToArchive = db.prepare("SELECT * FROM admin_audit_logs WHERE action IN ('ACTIVE_ACTION_1', 'ACTIVE_ACTION_2')").all() as any[];
      for (const l of logsToArchive) {
        db.prepare("UPDATE admin_audit_logs SET is_archived = 1, archived_at = datetime('now') WHERE id = ?").run(l.id);
      }

      const archivedCountBefore = (db.prepare('SELECT COUNT(*) as count FROM admin_audit_logs WHERE is_archived = 1').get() as any).count;
      expect(archivedCountBefore).toBe(2);

      // Wrong phrase returns 400
      const wrongPhrase = await request(app)
        .post('/api/admin/audit-logs/bulk-delete-archived')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationPhrase: 'DELETE ARCHIVE' });
      expect(wrongPhrase.status).toBe(400);
      expect(wrongPhrase.body.code).toBe('CONFIRMATION_MISMATCH');

      // Exact phrase deletes archived logs
      const bulkRes = await request(app)
        .post('/api/admin/audit-logs/bulk-delete-archived')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationPhrase: 'DELETE ALL ARCHIVED LOGS' });

      expect(bulkRes.status).toBe(200);
      expect(bulkRes.body.success).toBe(true);
      expect(bulkRes.body.data.count).toBe(2);

      // Archived count is now 0
      const archivedCountAfter = (db.prepare('SELECT COUNT(*) as count FROM admin_audit_logs WHERE is_archived = 1').get() as any).count;
      expect(archivedCountAfter).toBe(0);

      // Active log (ACTIVE_ACTION_3) is still in database!
      const activeLog3 = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ACTIVE_ACTION_3' AND is_archived = 0").get();
      expect(activeLog3).toBeDefined();

      // Active deletion audit log was created
      const bulkAudit = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ARCHIVED_AUDIT_LOGS_BULK_DELETED' AND is_archived = 0").get() as any;
      expect(bulkAudit).toBeDefined();
      expect(JSON.parse(bulkAudit.details).deletedCount).toBe(2);
    });

    it('denies ordinary users from deleting archived logs', async () => {
      const res = await request(app)
        .post('/api/admin/audit-logs/some-id/delete')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });
  });
});
