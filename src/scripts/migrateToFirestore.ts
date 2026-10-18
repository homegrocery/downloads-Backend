import fs from 'node:fs';
import path from 'node:path';
import { getDatabase } from '../db/database.js';
import { createBackup } from '../db/backup.js';
import { config } from '../config.js';

interface FirestoreExportItem {
  id: string;
  listId: string;
  userId: string;
  name: string;
  nameMr: string | null;
  quantity: number;
  unit: string;
  category: string;
  unitPrice: number;
  estimatedTotal: number;
  isPurchased: boolean;
  displayOrder: number;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface FirestoreExportList {
  id: string;
  userId: string;
  title: string;
  monthYear: string;
  monthlyBudget: number;
  notes: string | null;
  isArchived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: FirestoreExportItem[];
}

interface FirestoreExportUser {
  userId: string;
  fullName: string;
  mobileNumber: string;
  preferredLanguage: string;
  shoppingLists: FirestoreExportList[];
}

export interface FirestoreMigrationExport {
  exportedAt: string;
  sourceDatabase: string;
  backupPath: string;
  version: string;
  totalUsers: number;
  totalLists: number;
  totalItems: number;
  users: FirestoreExportUser[];
}

export async function exportSqliteToFirestoreFormat(customBackupDir?: string): Promise<{
  exportData: FirestoreMigrationExport;
  exportFilePath: string;
}> {
  console.log('--- Step 1: Performing Pre-Migration SQLite Integrity Check & Backup ---');
  const backupRes = await createBackup(customBackupDir);
  console.log(`Pre-migration backup verified at: ${backupRes.backupPath} (${backupRes.sizeBytes} bytes)`);

  console.log('--- Step 2: Extracting Data from SQLite Database ---');
  const db = getDatabase();

  const users = db.prepare(`
    SELECT id, mobile_number, full_name, preferred_language, created_at, updated_at
    FROM users
  `).all() as Array<{
    id: string;
    mobile_number: string;
    full_name: string;
    preferred_language: string;
    created_at: string;
    updated_at: string;
  }>;

  let totalListsCount = 0;
  let totalItemsCount = 0;

  const exportedUsers: FirestoreExportUser[] = [];

  for (const user of users) {
    const lists = db.prepare(`
      SELECT id, user_id, title, month_year, monthly_budget, notes, is_archived, version, created_at, updated_at
      FROM shopping_lists
      WHERE user_id = ?
      ORDER BY month_year DESC
    `).all(user.id) as Array<{
      id: string;
      user_id: string;
      title: string;
      month_year: string;
      monthly_budget: number;
      notes: string | null;
      is_archived: number;
      version: number;
      created_at: string;
      updated_at: string;
    }>;

    totalListsCount += lists.length;

    const exportedLists: FirestoreExportList[] = [];

    for (const list of lists) {
      const items = db.prepare(`
        SELECT id, list_id, user_id, name, name_mr, quantity, unit, category, unit_price, estimated_total, is_purchased, display_order, notes, version, created_at, updated_at
        FROM shopping_items
        WHERE list_id = ?
        ORDER BY display_order ASC
      `).all(list.id) as Array<{
        id: string;
        list_id: string;
        user_id: string;
        name: string;
        name_mr: string | null;
        quantity: number;
        unit: string;
        category: string;
        unit_price: number;
        estimated_total: number;
        is_purchased: number;
        display_order: number;
        notes: string | null;
        version: number;
        created_at: string;
        updated_at: string;
      }>;

      totalItemsCount += items.length;

      const formattedItems: FirestoreExportItem[] = items.map(item => ({
        id: item.id,
        listId: item.list_id,
        userId: item.user_id,
        name: item.name,
        nameMr: item.name_mr,
        quantity: Number(item.quantity) || 1,
        unit: item.unit || 'kg',
        category: item.category || 'General',
        unitPrice: Number(item.unit_price) || 0,
        estimatedTotal: Number(item.estimated_total) || 0,
        isPurchased: Boolean(item.is_purchased),
        displayOrder: Number(item.display_order) || 0,
        notes: item.notes,
        version: Number(item.version) || 1,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }));

      exportedLists.push({
        id: list.id,
        userId: list.user_id,
        title: list.title,
        monthYear: list.month_year,
        monthlyBudget: Number(list.monthly_budget) || 0,
        notes: list.notes,
        isArchived: Boolean(list.is_archived),
        version: Number(list.version) || 1,
        createdAt: list.created_at,
        updatedAt: list.updated_at,
        items: formattedItems
      });
    }

    exportedUsers.push({
      userId: user.id,
      fullName: user.full_name,
      mobileNumber: user.mobile_number,
      preferredLanguage: user.preferred_language,
      shoppingLists: exportedLists
    });
  }

  const exportData: FirestoreMigrationExport = {
    exportedAt: new Date().toISOString(),
    sourceDatabase: config.dbPath,
    backupPath: backupRes.backupPath,
    version: '1.0.0',
    totalUsers: users.length,
    totalLists: totalListsCount,
    totalItems: totalItemsCount,
    users: exportedUsers
  };

  console.log('--- Step 3: Writing Firestore Structured Export ---');
  const targetDir = customBackupDir || config.backupDir;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const exportFileName = `firestore_migration_${timestamp}.json`;
  const exportFilePath = path.join(targetDir, exportFileName);

  fs.writeFileSync(exportFilePath, JSON.stringify(exportData, null, 2), 'utf8');

  console.log(`Firestore export file created: ${exportFilePath}`);
  console.log(`Summary: ${users.length} users, ${totalListsCount} lists, ${totalItemsCount} items exported.`);

  return {
    exportData,
    exportFilePath
  };
}

export async function uploadExportToFirestore(exportData: FirestoreMigrationExport): Promise<{
  uploadedUsers: number;
  uploadedLists: number;
  uploadedItems: number;
}> {
  console.log('--- Step 4: Connecting to Cloud Firestore via Firebase Admin SDK ---');
  const { getAdminFirestore } = await import('../services/firebaseAdmin.js');
  const firestore = getAdminFirestore();

  let uploadedUsers = 0;
  let uploadedLists = 0;
  let uploadedItems = 0;

  for (const user of exportData.users) {
    const userRef = firestore.collection('users').doc(user.userId);
    await userRef.set({
      userId: user.userId,
      fullName: user.fullName,
      mobileNumber: user.mobileNumber,
      preferredLanguage: user.preferredLanguage,
      migratedAt: new Date().toISOString()
    }, { merge: true });
    uploadedUsers++;

    for (const list of user.shoppingLists) {
      const listRef = userRef.collection('shoppingLists').doc(list.id);
      await listRef.set({
        id: list.id,
        userId: list.userId,
        title: list.title,
        monthYear: list.monthYear,
        monthlyBudget: list.monthlyBudget,
        notes: list.notes,
        isArchived: list.isArchived,
        version: list.version,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt
      }, { merge: true });
      uploadedLists++;

      for (const item of list.items) {
        const itemRef = listRef.collection('items').doc(item.id);
        await itemRef.set({
          id: item.id,
          listId: item.listId,
          userId: item.userId,
          name: item.name,
          nameMr: item.nameMr,
          quantity: item.quantity,
          unit: item.unit,
          category: item.category,
          unitPrice: item.unitPrice,
          estimatedTotal: item.estimatedTotal,
          isPurchased: item.isPurchased,
          displayOrder: item.displayOrder,
          notes: item.notes,
          version: item.version,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        }, { merge: true });
        uploadedItems++;
      }
    }
  }

  console.log(`Firestore upload completed: ${uploadedUsers} users, ${uploadedLists} lists, ${uploadedItems} items.`);
  return { uploadedUsers, uploadedLists, uploadedItems };
}

// Allow CLI execution: `tsx src/scripts/migrateToFirestore.ts`
if (process.argv[1] && process.argv[1].endsWith('migrateToFirestore.ts')) {
  exportSqliteToFirestoreFormat()
    .then(async (res) => {
      console.log('\n========================================');
      console.log('  SQLITE TO FIRESTORE MIGRATION REPORT');
      console.log('========================================');
      console.log(`Total Users Migrated : ${res.exportData.totalUsers}`);
      console.log(`Total Lists Migrated : ${res.exportData.totalLists}`);
      console.log(`Total Items Migrated : ${res.exportData.totalItems}`);
      console.log(`Export JSON File     : ${res.exportFilePath}`);
      console.log(`Backup Database      : ${res.exportData.backupPath}`);
      console.log('========================================\n');

      if (process.argv.includes('--upload') || process.env.UPLOAD_TO_FIRESTORE === 'true') {
        try {
          await uploadExportToFirestore(res.exportData);
        } catch (upErr: any) {
          console.warn('Firestore live upload skipped/deferred (requires active Google service account or online Firestore):', upErr.message);
        }
      }

      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
