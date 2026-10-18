import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, closeDatabase } from '../db/database.js';
import { exportSqliteToFirestoreFormat } from '../scripts/migrateToFirestore.js';
import { AuthService } from '../services/authService.js';
import { ListService } from '../services/listService.js';

describe('SQLite to Firestore Migration Script', () => {
  const testDbDir = path.resolve(process.cwd(), 'test-data-migrate');
  const testDbPath = path.join(testDbDir, 'test_migrate.db');
  const testBackupDir = path.join(testDbDir, 'backups');

  beforeEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDbDir, { recursive: true });
    fs.mkdirSync(testBackupDir, { recursive: true });

    initDatabase(testDbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  it('safely backups and exports SQLite data to Firestore schema format', async () => {
    // Seed user with 4-digit PIN
    const user4 = AuthService.register({
      mobileNumber: '9988776655',
      pin: '0123',
      pinLength: 4,
      fullName: 'User 4-Digit',
      preferredLanguage: 'mr'
    });

    // Seed shopping list
    const list = ListService.createList(user4.user.id, {
      title: 'October Groceries',
      monthYear: '2026-10',
      monthlyBudget: 2500
    });

    // Seed shopping item
    ListService.addItem(user4.user.id, list.id, {
      name: 'Sugar',
      nameMr: 'साखर',
      quantity: 5,
      unit: 'kg',
      category: 'Kitchen Essentials',
      unitPrice: 42
    });

    const result = await exportSqliteToFirestoreFormat(testBackupDir);

    expect(result.exportData.totalUsers).toBe(1);
    expect(result.exportData.totalLists).toBe(1);
    expect(result.exportData.totalItems).toBe(1);
    expect(fs.existsSync(result.exportFilePath)).toBe(true);
    expect(fs.existsSync(result.exportData.backupPath)).toBe(true);

    const exportedUser = result.exportData.users[0];
    expect(exportedUser.userId).toBe(user4.user.id);
    expect(exportedUser.mobileNumber).toBe('9988776655');
    expect(exportedUser.shoppingLists).toHaveLength(1);

    const exportedList = exportedUser.shoppingLists[0];
    expect(exportedList.id).toBe(list.id);
    expect(exportedList.title).toBe('October Groceries');
    expect(exportedList.monthYear).toBe('2026-10');
    expect(exportedList.monthlyBudget).toBe(2500);
    expect(exportedList.items).toHaveLength(1);

    const exportedItem = exportedList.items[0];
    expect(exportedItem.name).toBe('Sugar');
    expect(exportedItem.nameMr).toBe('साखर');
    expect(exportedItem.quantity).toBe(5);
    expect(exportedItem.unitPrice).toBe(42);
    expect(exportedItem.estimatedTotal).toBe(210);
  });
});
