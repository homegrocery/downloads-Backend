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

  // Ensure shopping_items allows nullable unit_price and estimated_total
  try {
    const itemsInfo = db.prepare("PRAGMA table_info(shopping_items)").all() as Array<{ name: string; notnull: number }>;
    const priceCol = itemsInfo.find(col => col.name === 'unit_price');
    if (priceCol && priceCol.notnull === 1) {
      db.exec(`
        PRAGMA foreign_keys=OFF;
        CREATE TABLE IF NOT EXISTS shopping_items_upgrade (
          id TEXT PRIMARY KEY,
          list_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          name_mr TEXT,
          quantity REAL NOT NULL DEFAULT 1.0,
          unit TEXT NOT NULL DEFAULT 'kg',
          category TEXT NOT NULL DEFAULT 'Kitchen Essentials',
          unit_price REAL DEFAULT NULL,
          estimated_total REAL DEFAULT NULL,
          is_purchased INTEGER NOT NULL DEFAULT 0,
          display_order INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (list_id) REFERENCES shopping_lists(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO shopping_items_upgrade SELECT * FROM shopping_items;
        DROP TABLE shopping_items;
        ALTER TABLE shopping_items_upgrade RENAME TO shopping_items;
        CREATE INDEX IF NOT EXISTS idx_items_list ON shopping_items(list_id);
        CREATE INDEX IF NOT EXISTS idx_items_user ON shopping_items(user_id);
        PRAGMA foreign_keys=ON;
      `);
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
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_archived ON admin_audit_logs(is_archived);
    `);
  } catch {
    // ignore
  }

  // Ensure is_archived and archived_at exist on existing admin_audit_logs
  try {
    const auditInfo = db.prepare("PRAGMA table_info(admin_audit_logs)").all() as Array<{ name: string }>;
    if (auditInfo.length > 0 && !auditInfo.some(col => col.name === 'is_archived')) {
      db.exec("ALTER TABLE admin_audit_logs ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
    }
    if (auditInfo.length > 0 && !auditInfo.some(col => col.name === 'archived_at')) {
      db.exec("ALTER TABLE admin_audit_logs ADD COLUMN archived_at TEXT");
    }
  } catch {
    // ignore
  }

  // Owner admin bootstrap: verify designated owner exists and has admin role, demoting any others
  try {
    const adminMobile = config.adminMobileNumber;
    if (adminMobile) {
      const existingOwner = db.prepare("SELECT id, role FROM users WHERE mobile_number = ?").get(adminMobile) as { id: string; role: string } | undefined;
      if (existingOwner) {
        if (existingOwner.role !== 'admin') {
          db.prepare("UPDATE users SET role = 'admin' WHERE mobile_number = ?").run(adminMobile);
        }
      } else if (process.env.OWNER_SEED_PIN_HASH && process.env.OWNER_SEED_SALT) {
        const ownerId = process.env.OWNER_SEED_UUID || '24c7311d-9cb0-41c0-a0ed-cfee2ed69552';
        const ownerName = process.env.OWNER_SEED_NAME || 'Santosh Koli (Owner)';
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO users (id, mobile_number, pin_hash, salt, full_name, preferred_language, pin_length, role, failed_login_attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'mr', 6, 'admin', 0, ?, ?)
        `).run(ownerId, adminMobile, process.env.OWNER_SEED_PIN_HASH, process.env.OWNER_SEED_SALT, ownerName, now, now);
        console.log(`[BOOTSTRAP] Provisioned owner account ${adminMobile} (${ownerId}) with admin role.`);
      }
      db.prepare("UPDATE users SET role = 'user' WHERE mobile_number != ? AND role = 'admin'").run(adminMobile);
    }
  } catch (err) {
    console.error('[BOOTSTRAP] Error in owner admin bootstrap:', err);
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
