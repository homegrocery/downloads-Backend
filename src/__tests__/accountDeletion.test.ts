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
});
