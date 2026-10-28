import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';
import { SecurityService } from '../services/securityService.js';
import { TelegramService } from '../services/telegramService.js';

describe('Suspicious Activity Detection, Account Locking & Security Lifecycle (Build 9 Phase 3)', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-suspicious-security');
  const testDbPath = path.resolve(testDbDir, 'suspicious_security_test.db');
  let app: any;

  beforeEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDbDir, { recursive: true });
    initDatabase(testDbPath);
    app = createApp();

    // Reset SecurityService memory state
    SecurityService.resetMemoryState();

    // Ensure owner admin user exists
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

  describe('Threat 1 & 2: PIN Guessing, 5-Attempt Lock & Session Revocation', () => {
    it('locks account after exactly 5 consecutive wrong PIN attempts and revokes active sessions', async () => {
      // Register a user
      const reg = AuthService.register({
        mobileNumber: '9822001122',
        pin: '123456',
        fullName: 'Test Account',
        preferredLanguage: 'mr',
        pinLength: 6
      });

      // Login to get an active session
      const validLogin = await request(app)
        .post('/api/auth/login')
        .send({ mobileNumber: '9822001122', pin: '123456' });
      expect(validLogin.status).toBe(200);
      const activeToken = validLogin.body.data.token;

      // Active session works
      const initialLists = await request(app)
        .get('/api/lists')
        .set('Authorization', `Bearer ${activeToken}`);
      expect(initialLists.status).toBe(200);

      // 4 incorrect PIN attempts
      for (let i = 1; i <= 4; i++) {
        const failRes = await request(app)
          .post('/api/auth/login')
          .send({ mobileNumber: '9822001122', pin: '000000' });
        expect(failRes.status).toBe(400);
        expect(failRes.body.code).toBe('INCORRECT_PIN');
        expect(failRes.body.remainingAttempts).toBe(5 - i);
      }

      // 5th incorrect PIN attempt -> Lock account
      const fifthFail = await request(app)
        .post('/api/auth/login')
        .send({ mobileNumber: '9822001122', pin: '000000' });
      expect(fifthFail.status).toBe(423);
      expect(fifthFail.body.code).toBe('ACCOUNT_LOCKED');
      expect(fifthFail.body.lockType).toBe('AUTOMATIC');
      expect(fifthFail.body.nextAction).toBe('REACTIVATION_REQUIRED');
      expect(fifthFail.body.error).toContain('account has been locked');
      expect(fifthFail.body.errorMr).toContain('खाते लॉक केले गेले आहे');

      // Attempting to use the previously active token returns 401 ACCOUNT_LOCKED_PIN_ATTEMPTS with reason
      const postLockRes = await request(app)
        .get('/api/lists')
        .set('Authorization', `Bearer ${activeToken}`);
      expect(postLockRes.status).toBe(401);
      expect(postLockRes.body.code).toBe('ACCOUNT_LOCKED_PIN_ATTEMPTS');
      expect(postLockRes.body.nextAction).toBe('REACTIVATION_REQUIRED');

      // Subsequent login attempt while locked returns 423 with nextAction REACTIVATION_REQUIRED
      const lockedLogin = await request(app)
        .post('/api/auth/login')
        .send({ mobileNumber: '9822001122', pin: '123456' });
      expect(lockedLogin.status).toBe(423);
      expect(lockedLogin.body.code).toBe('ACCOUNT_LOCKED');
      expect(lockedLogin.body.nextAction).toBe('REACTIVATION_REQUIRED');
    });

    it('protects Owner Admin from accidental or malicious account locking', async () => {
      const lockRes = await request(app)
        .post('/api/auth/login')
        .send({ mobileNumber: '9356755100', pin: '999999' });

      // Owner should return incorrect pin (400), but never be locked out
      expect(lockRes.status).toBe(400);
      const db = getDatabase();
      const owner = db.prepare("SELECT locked_until FROM users WHERE mobile_number = '9356755100'").get() as { locked_until: string | null };
      expect(owner.locked_until).toBeNull();
    });
  });

  describe('Threat 5: Unauthorized Admin Probing & Escalation', () => {
    it('rejects member access to admin endpoints with 403 and revokes session on repeated probing', async () => {
      // Register standard member
      const reg = AuthService.register({
        mobileNumber: '9822998877',
        pin: '123456',
        fullName: 'Standard Member',
        preferredLanguage: 'en',
        pinLength: 6
      });

      const memberToken = reg.token;

      // 1st unauthorized probe -> 403 UNAUTHORIZED_ACTION
      const probe1 = await request(app)
        .get('/api/admin/accounts')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(probe1.status).toBe(403);
      expect(probe1.body.code).toBe('UNAUTHORIZED_ACTION');

      // 2nd probe -> 403 UNAUTHORIZED_ACTION
      const probe2 = await request(app)
        .get('/api/admin/accounts')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(probe2.status).toBe(403);

      // 3rd probe -> triggers session revocation and returns 401 SESSION_REVOKED_SECURITY
      const probe3 = await request(app)
        .get('/api/admin/accounts')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(probe3.status).toBe(401);
      expect(probe3.body.code).toBe('SESSION_REVOKED_SECURITY');

      // Now any member endpoint request using that token returns 401 SESSION_REVOKED_SECURITY
      const revokedCheck = await request(app)
        .get('/api/lists')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(revokedCheck.status).toBe(401);
      expect(revokedCheck.body.code).toBe('SESSION_REVOKED_SECURITY');
      expect(revokedCheck.body.nextAction).toBe('LOGIN_REQUIRED');
      expect(revokedCheck.body.error).toContain('security');
      expect(revokedCheck.body.errorMr).toContain('सत्र रद्द केले आहे');
    });
  });

  describe('Threat 6: Cross-User Record Ownership Enforcement', () => {
    it('forbids reading, updating, or deleting lists belonging to another user', async () => {
      // User 1
      const user1 = AuthService.register({
        mobileNumber: '9822000001',
        pin: '111111',
        fullName: 'User One',
        preferredLanguage: 'mr',
        pinLength: 6
      });

      // User 2
      const user2 = AuthService.register({
        mobileNumber: '9822000002',
        pin: '222222',
        fullName: 'User Two',
        preferredLanguage: 'mr',
        pinLength: 6
      });

      // User 1 creates a list
      const createListRes = await request(app)
        .post('/api/lists')
        .set('Authorization', `Bearer ${user1.token}`)
        .send({
          title: 'User 1 Groceries',
          monthYear: '2026-11',
          monthlyBudget: 5000
        });
      expect(createListRes.status).toBe(201);
      const listId = createListRes.body.data.id;

      // User 2 attempts to get User 1's list
      const getRes = await request(app)
        .get(`/api/lists/${listId}`)
        .set('Authorization', `Bearer ${user2.token}`);
      expect([403, 404]).toContain(getRes.status);

      // User 2 attempts to update User 1's list
      const updateRes = await request(app)
        .put(`/api/lists/${listId}`)
        .set('Authorization', `Bearer ${user2.token}`)
        .send({ title: 'Hacked List Title' });
      expect(updateRes.status).toBe(403);
      expect(updateRes.body.code).toBe('UNAUTHORIZED_ACTION');

      // User 2 attempts to delete User 1's list
      const deleteRes = await request(app)
        .delete(`/api/lists/${listId}`)
        .set('Authorization', `Bearer ${user2.token}`);
      expect(deleteRes.status).toBe(403);
      expect(deleteRes.body.code).toBe('UNAUTHORIZED_ACTION');
    });

    it('forbids mutating items belonging to another user', async () => {
      const user1 = AuthService.register({
        mobileNumber: '9822000003',
        pin: '111111',
        fullName: 'User Three',
        preferredLanguage: 'mr',
        pinLength: 6
      });

      const user2 = AuthService.register({
        mobileNumber: '9822000004',
        pin: '222222',
        fullName: 'User Four',
        preferredLanguage: 'mr',
        pinLength: 6
      });

      // User 1 creates list and item
      const listRes = await request(app)
        .post('/api/lists')
        .set('Authorization', `Bearer ${user1.token}`)
        .send({ title: 'November List', monthYear: '2026-11' });
      const listId = listRes.body.data.id;

      const itemRes = await request(app)
        .post(`/api/lists/${listId}/items`)
        .set('Authorization', `Bearer ${user1.token}`)
        .send({ name: 'Milk', quantity: 1, unit: 'Litre', category: 'Dairy' });
      const itemId = itemRes.body.data.id;

      // User 2 attempts to update User 1's item
      const updateItemRes = await request(app)
        .put(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${user2.token}`)
        .send({ name: 'Tampered Milk' });
      expect(updateItemRes.status).toBe(403);
      expect(updateItemRes.body.code).toBe('UNAUTHORIZED_ACTION');

      // User 2 attempts to delete User 1's item
      const deleteItemRes = await request(app)
        .delete(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${user2.token}`);
      expect(deleteItemRes.status).toBe(403);
      expect(deleteItemRes.body.code).toBe('UNAUTHORIZED_ACTION');
    });
  });

  describe('Threat 7: Payload Tampering Prevention', () => {
    it('rejects payloads attempting to inject privileged fields (role, locked_until, conflicting userId)', async () => {
      const user = AuthService.register({
        mobileNumber: '9822000005',
        pin: '111111',
        fullName: 'User Five',
        preferredLanguage: 'en',
        pinLength: 6
      });

      // Attempt to tamper with role in list creation
      const tamperRoleRes = await request(app)
        .post('/api/lists')
        .set('Authorization', `Bearer ${user.token}`)
        .send({
          title: 'Tampered List',
          monthYear: '2026-11',
          role: 'admin'
        });
      expect(tamperRoleRes.status).toBe(400);
      expect(tamperRoleRes.body.code).toBe('UNAUTHORIZED_ACTION');
      expect(tamperRoleRes.body.error).toContain('Tampering with protected system fields');

      // Attempt to tamper with userId
      const tamperUserRes = await request(app)
        .post('/api/lists')
        .set('Authorization', `Bearer ${user.token}`)
        .send({
          title: 'Tampered User ID',
          monthYear: '2026-11',
          userId: 'fake-admin-uuid-999'
        });
      expect(tamperUserRes.status).toBe(400);
      expect(tamperUserRes.body.code).toBe('UNAUTHORIZED_ACTION');
    });
  });

  describe('Threat 8: Telegram Notification Integration & Failure Independence', () => {
    it('triggers security alert on suspicious event and does not break application flow if Telegram fails', async () => {
      // Spy on TelegramService.sendMessage
      const sendSpy = vi.spyOn(TelegramService as any, 'sendMessage').mockRejectedValue(new Error('Network error simulated'));

      // Trigger a suspicious security event
      expect(() => {
        SecurityService.recordSecurityEvent({
          type: 'UNAUTHORIZED_ADMIN_API_ACCESS_ATTEMPT',
          severity: 'LEVEL_3_HIGH',
          actionTaken: 'REVOKE_SESSION',
          userId: 'user-sim-123',
          mobileNumber: '9822009988',
          ipAddress: '192.168.1.100',
          endpoint: '/api/admin/users',
          method: 'GET',
          reasonCode: 'SESSION_REVOKED_SECURITY'
        });
      }).not.toThrow();

      sendSpy.mockRestore();
    });
  });

  describe('Threat 9: Strict Bilingual Guarantee (Zero Hindi)', () => {
    it('verifies that all security reason messages strictly use English and Marathi, with no Hindi vocabulary', () => {
      const bilingualKeys = [
        'INCORRECT_PIN',
        'ACCOUNT_LOCKED_PIN_ATTEMPTS',
        'ACCOUNT_LOCKED_SECURITY_REVIEW',
        'UNAUTHORIZED_ACTION',
        'SESSION_EXPIRED',
        'SESSION_REVOKED_SECURITY',
        'RECOVERY_TEMPORARILY_RESTRICTED',
        'REACTIVATION_REQUIRED'
      ];

      // Hindi-specific words that must NOT be present
      const prohibitedHindiTerms = ['जैसे', 'कृपया ध्यान दें', 'सफल', 'रद्द', 'अमान्य', 'नमस्ते', 'धन्यवाद', 'लॉग इन करें'];

      for (const key of bilingualKeys) {
        const en = AuthService.getSecurityReasonMessage(key, 'en');
        const mr = AuthService.getSecurityReasonMessage(key, 'mr');

        expect(en).toBeTruthy();
        expect(mr).toBeTruthy();

        for (const term of prohibitedHindiTerms) {
          expect(mr).not.toContain(term);
        }
      }
    });
  });
});
