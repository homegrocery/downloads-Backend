import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDatabase } from './database.js';
import { config } from '../config.js';

export async function createBackup(
  customBackupDir?: string,
  sourceDb?: Database.Database
): Promise<{ backupPath: string; sizeBytes: number }> {
  const db = sourceDb || getDatabase();
  const targetDir = customBackupDir || config.backupDir;

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `homegrocery_backup_${timestamp}.db`;
  const backupFilePath = path.join(targetDir, backupFileName);

  // Perform online backup using better-sqlite3 backup API
  await db.backup(backupFilePath);

  // Verify backup integrity
  const backupDb = new Database(backupFilePath, { readonly: true });
  const integrity = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
  backupDb.close();

  if (!integrity || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('Database backup failed integrity check');
  }

  const stats = fs.statSync(backupFilePath);
  return {
    backupPath: backupFilePath,
    sizeBytes: stats.size
  };
}

export function restoreBackup(backupFilePath: string, targetPath?: string): boolean {
  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`Backup file not found at ${backupFilePath}`);
  }

  // Verify integrity before restoring
  const backupDb = new Database(backupFilePath, { readonly: true });
  const integrity = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
  backupDb.close();

  if (!integrity || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('Corrupted backup file cannot be restored');
  }

  const target = targetPath || config.dbPath;
  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy verified backup file to destination
  fs.copyFileSync(backupFilePath, target);
  return true;
}

// Allow CLI execution: `tsx src/db/backup.ts`
if (process.argv[1] && process.argv[1].endsWith('backup.ts')) {
  createBackup()
    .then((res) => {
      console.log(`Backup completed successfully: ${res.backupPath} (${res.sizeBytes} bytes)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Backup failed:', err);
      process.exit(1);
    });
}
