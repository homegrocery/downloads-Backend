import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dbInstance: Database.Database | null = null;

export function initDatabase(dbFilePath?: string): Database.Database {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }

  const targetPath = dbFilePath || config.dbPath;

  if (targetPath !== ':memory:') {
    const dbDir = path.dirname(targetPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  const db = new Database(targetPath);

  // WAL mode (only for disk-backed databases)
  if (targetPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Initialize schema
  const candidatePaths = [
    path.resolve(__dirname, 'schema.sql'),
    path.resolve(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
    path.resolve(process.cwd(), 'src', 'db', 'schema.sql')
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      const schemaSql = fs.readFileSync(p, 'utf8');
      db.exec(schemaSql);
      break;
    }
  }

  // Ensure pin_length and role columns exist on existing user records
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    if (tableInfo.length > 0 && !tableInfo.some(col => col.name === 'pin_length')) {
      db.exec("ALTER TABLE users ADD COLUMN pin_length INTEGER NOT NULL DEFAULT 6");
    }
    if (tableInfo.length > 0 && !tableInfo.some(col => col.name === 'role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }
  } catch {
    // ignore
  }

  // Ensure recovery and admin tables exist on existing databases
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_status ON recovery_codes(user_id, status);

      CREATE TABLE IF NOT EXISTS recovery_authorizations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        recovery_code_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (recovery_code_id) REFERENCES recovery_codes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_auth_token ON recovery_authorizations(token_hash);
      CREATE INDEX IF NOT EXISTS idx_recovery_auth_user ON recovery_authorizations(user_id);

      CREATE TABLE IF NOT EXISTS recovery_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        mobile_number TEXT NOT NULL,
        request_token_hash TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        verification_method TEXT,
        verification_notes TEXT,
        approved_code_encrypted TEXT,
        approved_code_iv TEXT,
        approved_code_tag TEXT,
        approved_code_hash TEXT,
        approved_code_salt TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_req_token ON recovery_requests(request_token_hash);
      CREATE INDEX IF NOT EXISTS idx_recovery_req_user ON recovery_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_recovery_req_mobile ON recovery_requests(mobile_number);
      CREATE INDEX IF NOT EXISTS idx_recovery_req_status ON recovery_requests(status);

      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id TEXT PRIMARY KEY,
        admin_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_account_id TEXT,
        target_mobile_number TEXT,
        details TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_logs(action);
    `);
  } catch {
    // ignore
  }

  // Owner admin bootstrap: verify designated owner exists and has admin role, demoting any others
  try {
    const adminMobile = config.adminMobileNumber;
    if (adminMobile) {
      db.prepare("UPDATE users SET role = 'admin' WHERE mobile_number = ? AND role != 'admin'").run(adminMobile);
      db.prepare("UPDATE users SET role = 'user' WHERE mobile_number != ? AND role = 'admin'").run(adminMobile);
    }
  } catch {
    // ignore
  }

  dbInstance = db;
  return db;
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

export function setDatabase(db: Database.Database | null): void {
  dbInstance = db;
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }
}
