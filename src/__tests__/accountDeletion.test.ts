import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';
import { ListService } from '../services/listService.js';

describe('Admin Permanent Account Deletion & Cascading Clean-up', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-account-del');
  const testDbPath = path.resolve(testDbDir, 'account_del_test.db');
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

  it('permanently deletes an account with explicit confirmations and cascades across all tables', async () => {
    const db = getDatabase();

    // 1. Create target user with grocery list and items
    const userReg = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Account To Delete',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    const list = ListService.createList(userReg.user.id, {
      title: 'Diwali Shopping',
      monthYear: '2026-10'
    });

    ListService.addItem(userReg.user.id, list.id, {
      name: 'Rava / Suji',
      nameMr: 'रवा',
      quantity: 2,
      unit: 'kg',
      category: 'Grains',
      unitPrice: 50
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

    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const adminToken = adminLoginRes.body.data.token;

    // 3. Attempt deletion without correct confirmation phrase -> fails
    const badPhraseRes = await request(app)
      .post(`/api/admin/accounts/${userReg.user.id}/delete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirmMobileNumber: '9876543210',
        confirmationPhrase: 'REMOVE'
      });

    expect(badPhraseRes.status).toBe(400);
    expect(badPhraseRes.body.error).toContain('CONFIRMATION_MISMATCH');

    // 4. Attempt deletion with wrong mobile number -> fails
    const badMobileRes = await request(app)
      .post(`/api/admin/accounts/${userReg.user.id}/delete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirmMobileNumber: '9999999999',
        confirmationPhrase: 'DELETE'
      });

    expect(badMobileRes.status).toBe(400);
    expect(badMobileRes.body.error).toContain('MOBILE_MISMATCH');

    // 5. Admin cannot delete their own account
    const selfDeleteRes = await request(app)
      .post(`/api/admin/accounts/${adminReg.user.id}/delete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirmMobileNumber: '9356755100',
        confirmationPhrase: 'DELETE'
      });

    expect(selfDeleteRes.status).toBe(400);
    expect(selfDeleteRes.body.error).toContain('CANNOT_DELETE_SELF');

    // 6. Valid deletion
    const deleteRes = await request(app)
      .post(`/api/admin/accounts/${userReg.user.id}/delete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirmMobileNumber: '9876543210',
        confirmationPhrase: 'DELETE'
      });

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
    expect(deleteRes.body.data.deletedAccountId).toBe(userReg.user.id);

    // 7. Verify cascade deletion across all tables
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userReg.user.id);
    expect(userRow).toBeUndefined();

    const lists = db.prepare('SELECT * FROM shopping_lists WHERE user_id = ?').all(userReg.user.id);
    expect(lists.length).toBe(0);

    const items = db.prepare('SELECT * FROM shopping_items WHERE user_id = ?').all(userReg.user.id);
    expect(items.length).toBe(0);

    const sessions = db.prepare('SELECT * FROM authentication_sessions WHERE user_id = ?').all(userReg.user.id);
    expect(sessions.length).toBe(0);

    const recoveryCodes = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').all(userReg.user.id);
    expect(recoveryCodes.length).toBe(0);

    // 8. Verify audit log entry exists
    const auditLogs = db.prepare('SELECT * FROM admin_audit_logs WHERE target_account_id = ?').all(userReg.user.id) as any[];
    expect(auditLogs.some(l => l.action === 'ACCOUNT_DELETED')).toBe(true);

    // 9. Deleted user cannot authenticate
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({
        mobileNumber: '9876543210',
        pin: '123456'
      });

    expect(loginRes.status).toBe(400);
  });

  it('bulk deletes ordinary accounts with DELETE ALL ORDINARY USERS while strictly preserving owner 9356755100', async () => {
    const db = getDatabase();

    // Register owner admin
    const ownerReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ownerReg.user.id);

    // Register 2 ordinary users
    const u1 = AuthService.register({
      mobileNumber: '9800000001',
      pin: '111111',
      fullName: 'Ordinary User 1',
      preferredLanguage: 'en',
      pinLength: 6
    });
    const u2 = AuthService.register({
      mobileNumber: '9800000002',
      pin: '222222',
      fullName: 'Ordinary User 2',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // Create lists and items for ordinary users
    const list1 = ListService.createList(u1.user.id, { title: 'U1 List', monthYear: '2026-10' });
    ListService.addItem(u1.user.id, list1.id, { name: 'Rice', quantity: 5, unit: 'kg' });
    const list2 = ListService.createList(u2.user.id, { title: 'U2 List', monthYear: '2026-10' });
    ListService.addItem(u2.user.id, list2.id, { name: 'Wheat', quantity: 10, unit: 'kg' });

    // Admin login
    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const adminToken = adminLoginRes.body.data.token;

    // Bad confirmation phrase -> fails
    const badPhrase = await request(app)
      .post('/api/admin/accounts/bulk-delete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmationPhrase: 'DELETE ALL' });
    expect(badPhrase.status).toBe(400);
    expect(badPhrase.body.error).toContain('CONFIRMATION_MISMATCH');

    // Valid bulk delete
    const bulkRes = await request(app)
      .post('/api/admin/accounts/bulk-delete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmationPhrase: 'DELETE ALL ORDINARY USERS' });

    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.success).toBe(true);
    expect(bulkRes.body.data.deletedCount).toBe(2);
    expect(bulkRes.body.data.deletedAccountIds).toContain(u1.user.id);
    expect(bulkRes.body.data.deletedAccountIds).toContain(u2.user.id);

    // Verify owner account is NOT deleted and still admin
    const ownerRow = db.prepare('SELECT * FROM users WHERE mobile_number = ?').get('9356755100') as any;
    expect(ownerRow).toBeDefined();
    expect(ownerRow.role).toBe('admin');

    // Verify ordinary users deleted along with lists and items
    const checkU1 = db.prepare('SELECT * FROM users WHERE id = ?').get(u1.user.id);
    const checkU2 = db.prepare('SELECT * FROM users WHERE id = ?').get(u2.user.id);
    expect(checkU1).toBeUndefined();
    expect(checkU2).toBeUndefined();

    const lists = db.prepare('SELECT * FROM shopping_lists').all();
    expect(lists.length).toBe(0);

    // Verify audit log has ACCOUNTS_BULK_DELETED
    const auditRes = await request(app)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(auditRes.body.data.logs.some((l: any) => l.action === 'ACCOUNTS_BULK_DELETED')).toBe(true);
  });

  it('archives single audit entry and bulk archives all audit logs with DELETE ALL AUDIT LOGS', async () => {
    const db = getDatabase();

    // Register owner admin
    const ownerReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ownerReg.user.id);

    // Admin login to create audit entries
    const adminLoginRes = await request(app)
      .post('/api/admin/auth/login')
      .send({ mobileNumber: '9356755100', pin: '654321' });
    const adminToken = adminLoginRes.body.data.token;

    // Fetch active logs
    const initialLogsRes = await request(app)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    const activeLogs = initialLogsRes.body.data.logs;
    expect(activeLogs.length).toBeGreaterThan(0);

    // Archive first log
    const targetLogId = activeLogs[0].id;
    const archiveOneRes = await request(app)
      .post(`/api/admin/audit-logs/${targetLogId}/archive`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(archiveOneRes.status).toBe(200);
    expect(archiveOneRes.body.success).toBe(true);

    // Verify targetLogId is no longer in active logs
    const afterOneRes = await request(app)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(afterOneRes.body.data.logs.some((l: any) => l.id === targetLogId)).toBe(false);

    // Verify targetLogId is in archived logs
    const archivedRes = await request(app)
      .get('/api/admin/audit-logs?showArchived=true')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(archivedRes.body.data.logs.some((l: any) => l.id === targetLogId)).toBe(true);

    // Bulk archive without exact phrase fails
    const badBulk = await request(app)
      .post('/api/admin/audit-logs/archive-all')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmationPhrase: 'DELETE LOGS' });
    expect(badBulk.status).toBe(400);
    expect(badBulk.body.error).toContain('CONFIRMATION_MISMATCH');

    // Bulk archive with exact phrase
    const bulkArchiveRes = await request(app)
      .post('/api/admin/audit-logs/archive-all')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmationPhrase: 'DELETE ALL AUDIT LOGS' });
    expect(bulkArchiveRes.status).toBe(200);
    expect(bulkArchiveRes.body.success).toBe(true);

    // Verify only the AUDIT_LOGS_BULK_ARCHIVED entry is present in active logs
    const activeAfterBulk = await request(app)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(activeAfterBulk.body.data.logs.length).toBe(1);
    expect(activeAfterBulk.body.data.logs[0].action).toBe('AUDIT_LOGS_BULK_ARCHIVED');

    // All previous logs still exist in database with is_archived = 1
    const allDbLogs = db.prepare('SELECT * FROM admin_audit_logs').all() as any[];
    expect(allDbLogs.length).toBeGreaterThan(1);
  });
});

