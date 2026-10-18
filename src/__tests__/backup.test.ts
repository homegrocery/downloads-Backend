import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { createBackup, restoreBackup } from '../db/backup.js';
import { AuthService } from '../services/authService.js';
import { ListService } from '../services/listService.js';

const TEST_BACKUP_DIR = path.resolve(process.cwd(), 'data', 'test_backups');
const RESTORE_TARGET_DB = path.resolve(process.cwd(), 'data', 'restored_verification.db');

describe('Database Online Backup & Restoration', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    if (!fs.existsSync(TEST_BACKUP_DIR)) {
      fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });
    }
    if (fs.existsSync(RESTORE_TARGET_DB)) {
      fs.unlinkSync(RESTORE_TARGET_DB);
    }
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_BACKUP_DIR)) {
      fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(RESTORE_TARGET_DB)) {
      fs.unlinkSync(RESTORE_TARGET_DB);
    }
  });

  it('creates an online backup and restores it into a target database with full data persistence', async () => {
    // 1. Populate origin database
    const user = AuthService.register({
      mobileNumber: '9876543210',
      pin: '123456',
      fullName: 'Santosh Koli'
    }).user;

    const list = ListService.createList(user.id, {
      title: 'October Backup Test',
      monthYear: '2026-10',
      monthlyBudget: 5000
    });

    ListService.addItem(user.id, list.id, {
      name: 'Toor Dal',
      nameMr: 'तूर डाळ',
      quantity: 2,
      unit: 'kg',
      category: 'Grains and Pulses',
      unitPrice: 160
    });

    // 2. Perform online backup from active in-memory database to disk
    const backupResult = await createBackup(TEST_BACKUP_DIR, getDatabase());
    expect(fs.existsSync(backupResult.backupPath)).toBe(true);
    expect(backupResult.sizeBytes).toBeGreaterThan(0);

    // 3. Restore backup to clean target location
    const restored = restoreBackup(backupResult.backupPath, RESTORE_TARGET_DB);
    expect(restored).toBe(true);

    // 4. Verify all records survived in restored database
    const restoredDb = new Database(RESTORE_TARGET_DB, { readonly: true });
    const userRow = restoredDb.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as any;
    expect(userRow).toBeDefined();
    expect(userRow.mobile_number).toBe('9876543210');
    expect(userRow.full_name).toBe('Santosh Koli');

    const listRow = restoredDb.prepare('SELECT * FROM shopping_lists WHERE id = ?').get(list.id) as any;
    expect(listRow).toBeDefined();
    expect(listRow.title).toBe('October Backup Test');

    const itemRow = restoredDb.prepare('SELECT * FROM shopping_items WHERE list_id = ?').get(list.id) as any;
    expect(itemRow).toBeDefined();
    expect(itemRow.name).toBe('Toor Dal');
    expect(itemRow.name_mr).toBe('तूर डाळ');
    expect(itemRow.quantity).toBe(2);
    expect(itemRow.unit_price).toBe(160);

    restoredDb.close();
  });
});
