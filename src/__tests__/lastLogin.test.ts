import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { AuthService } from '../services/authService.js';
import { AdminService } from '../services/adminService.js';

describe('Admin ERP & Backend — Last Login Timestamp Verification', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-last-login');
  const testDbPath = path.resolve(testDbDir, 'last_login_test.db');
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

  it('account creation (registration) does not invent a login timestamp (last_login_at is null)', async () => {
    const db = getDatabase();

    const reg = AuthService.register({
      mobileNumber: '9820011223',
      pin: '123456',
      fullName: 'New Unauthenticated User',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // Verify database row directly
    const userRow = db.prepare('SELECT id, last_login_at FROM users WHERE id = ?').get(reg.user.id) as any;
    expect(userRow).toBeDefined();
    expect(userRow.last_login_at).toBeNull();

    // Verify safeUser from registration does not claim a login timestamp
    expect(reg.user.last_login_at).toBeUndefined();
  });

  it('failed login attempt does not update last_login_at', async () => {
    const db = getDatabase();

    const reg = AuthService.register({
      mobileNumber: '9820011224',
      pin: '123456',
      fullName: 'Failed Login Target',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // Attempt login with incorrect PIN
    expect(() => {
      AuthService.login({
        mobileNumber: '9820011224',
        pin: '999999'
      });
    }).toThrow('INVALID_CREDENTIALS');

    // Confirm last_login_at remains strictly null
    const userRow = db.prepare('SELECT failed_login_attempts, last_login_at FROM users WHERE id = ?').get(reg.user.id) as any;
    expect(userRow.failed_login_attempts).toBe(1);
    expect(userRow.last_login_at).toBeNull();
  });

  it('successful user login records genuine last_login_at timestamp', async () => {
    const db = getDatabase();

    const reg = AuthService.register({
      mobileNumber: '9820011225',
      pin: '123456',
      fullName: 'Valid Login User',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    const beforeLogin = new Date(Date.now() - 1000).toISOString();
    const loginResult = AuthService.login({
      mobileNumber: '9820011225',
      pin: '123456'
    });
    const afterLogin = new Date(Date.now() + 1000).toISOString();

    expect(loginResult.user.last_login_at).toBeDefined();
    expect(loginResult.user.last_login_at).not.toBeNull();

    // Verify in database
    const userRow = db.prepare('SELECT last_login_at, failed_login_attempts FROM users WHERE id = ?').get(reg.user.id) as any;
    expect(userRow.last_login_at).toBe(loginResult.user.last_login_at);
    expect(userRow.failed_login_attempts).toBe(0);
    expect(userRow.last_login_at >= beforeLogin).toBe(true);
    expect(userRow.last_login_at <= afterLogin).toBe(true);
  });

  it('successful owner admin login records last_login_at timestamp', async () => {
    const db = getDatabase();

    const adminReg = AuthService.register({
      mobileNumber: '9356755100',
      pin: '654321',
      fullName: 'Santosh Koli Owner',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminReg.user.id);

    const loginRes = await AdminService.loginAdmin({
      mobileNumber: '9356755100',
      pin: '654321'
    });

    expect(loginRes.user.last_login_at).toBeDefined();
    expect(loginRes.user.last_login_at).not.toBeNull();

    const adminRow = db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(adminReg.user.id) as any;
    expect(adminRow.last_login_at).toBe(loginRes.user.last_login_at);
  });

  it('AdminService.getAccounts returns correct last_login_at and handles accounts without logins', async () => {
    const db = getDatabase();

    // Account 1: Logged in
    const user1 = AuthService.register({
      mobileNumber: '9820099001',
      pin: '111111',
      fullName: 'Logged In Customer',
      preferredLanguage: 'mr',
      pinLength: 6
    });
    const login1 = AuthService.login({
      mobileNumber: '9820099001',
      pin: '111111'
    });

    // Account 2: Never logged in
    const user2 = AuthService.register({
      mobileNumber: '9820099002',
      pin: '222222',
      fullName: 'Never Logged In Customer',
      preferredLanguage: 'mr',
      pinLength: 6
    });

    // Fetch accounts directory
    const result = AdminService.getAccounts({ page: 1, limit: 10 });
    const acc1 = result.accounts.find(a => a.id === user1.user.id);
    const acc2 = result.accounts.find(a => a.id === user2.user.id);

    expect(acc1).toBeDefined();
    expect(acc1!.last_login_at).toBe(login1.user.last_login_at);

    expect(acc2).toBeDefined();
    expect(acc2!.last_login_at).toBeNull();
  });

  it('dynamic migration backfills last_login_at from verified historical authentication sessions', async () => {
    const db = getDatabase();

    // Create user and manual historical session
    const userId = 'usr-historical-test-1';
    const userCreatedAt = '2026-10-14T08:00:00.000Z';
    const historicalLoginTime = '2026-10-15T10:30:00.000Z';
    const expiresAt = '2026-10-22T10:30:00.000Z';

    db.prepare(`
      INSERT INTO users (id, mobile_number, pin_hash, salt, full_name, preferred_language, pin_length, role, last_login_at, created_at, updated_at)
      VALUES (?, '9820099003', 'hash', 'salt', 'Historical User', 'mr', 6, 'user', NULL, ?, ?)
    `).run(userId, userCreatedAt, userCreatedAt);

    db.prepare(`
      INSERT INTO authentication_sessions (id, user_id, token_hash, expires_at, created_at, last_active_at)
      VALUES ('sess-hist-1', ?, 'token_hash_abc', ?, ?, ?)
    `).run(userId, expiresAt, historicalLoginTime, historicalLoginTime);

    // Apply backfill migration query
    db.prepare(`
      UPDATE users
      SET last_login_at = (
        SELECT MAX(s.created_at) FROM authentication_sessions s WHERE s.user_id = users.id AND s.created_at > users.created_at
      )
      WHERE last_login_at IS NULL
        AND EXISTS (SELECT 1 FROM authentication_sessions s WHERE s.user_id = users.id AND s.created_at > users.created_at)
    `).run();

    // Run getAccounts to verify backfilled value
    const result = AdminService.getAccounts({ search: '9820099003' });
    const acc = result.accounts.find(a => a.id === userId);
    expect(acc).toBeDefined();
    expect(acc!.last_login_at).toBe(historicalLoginTime);
  });
});
