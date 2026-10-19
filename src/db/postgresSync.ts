import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import pg from 'pg';
import { convertQuestionMarksToDollarParams } from './postgresAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

export interface SyncStats {
  tablesCreated: boolean;
  recordsMigrated: number;
  neonConnected: boolean;
  ownerVerified: boolean;
}

let activePgPool: pg.Pool | null = null;

const TABLES_IN_ORDER = [
  'users',
  'shopping_lists',
  'shopping_items',
  'authentication_sessions',
  'recovery_codes',
  'recovery_authorizations',
  'recovery_requests',
  'admin_audit_logs'
];

export async function initPostgresSync(db: Database.Database, databaseUrl: string): Promise<SyncStats> {
  if (!databaseUrl || !databaseUrl.trim()) {
    return { tablesCreated: false, recordsMigrated: 0, neonConnected: false, ownerVerified: false };
  }

  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  const client = await pool.connect();
  const stats: SyncStats = {
    tablesCreated: false,
    recordsMigrated: 0,
    neonConnected: true,
    ownerVerified: false
  };

  try {
    console.log('[NEON SYNC] Connected to Neon PostgreSQL over TLS.');

    // 1. Check existing tables
    const tableRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const existingTables = new Set(tableRes.rows.map(r => r.table_name));

    // 2. Apply schema if missing
    if (!existingTables.has('users') || !existingTables.has('shopping_lists')) {
      console.log('[NEON SYNC] Public tables missing in Neon. Applying schema.pg.sql...');
      const schemaPaths = [
        path.resolve(__dirname, 'schema.pg.sql'),
        path.resolve(process.cwd(), 'src', 'db', 'schema.pg.sql'),
        path.resolve(process.cwd(), 'dist', 'db', 'schema.pg.sql')
      ];
      let ddlSql = '';
      for (const p of schemaPaths) {
        if (fs.existsSync(p)) {
          ddlSql = fs.readFileSync(p, 'utf8');
          break;
        }
      }
      if (ddlSql) {
        await client.query(ddlSql);
        stats.tablesCreated = true;
        console.log('[NEON SYNC] schema.pg.sql applied successfully.');
      }
    }

    // 3. Check if Neon has data in users
    const userCountRes = await client.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountRes.rows[0].count, 10);

    if (userCount === 0) {
      console.log('[NEON SYNC] Neon users table is empty. Loading authoritative verified backup snapshot...');
      let seedData: Record<string, any[]> = {};

      // Check SQLite backup file first
      const backupPath = path.resolve(process.cwd(), 'backups', 'homegrocery_backup_20261019_161649.db');
      const seedJsonPaths = [
        path.resolve(__dirname, 'verifiedBackupSeed.json'),
        path.resolve(process.cwd(), 'src', 'db', 'verifiedBackupSeed.json'),
        path.resolve(process.cwd(), 'dist', 'db', 'verifiedBackupSeed.json')
      ];

      for (const p of seedJsonPaths) {
        if (fs.existsSync(p)) {
          seedData = JSON.parse(fs.readFileSync(p, 'utf8'));
          break;
        }
      }

      await client.query('BEGIN');
      try {
        let totalInserted = 0;
        for (const table of TABLES_IN_ORDER) {
          const rows = seedData[table] || [];
          if (rows.length === 0) continue;

          const columns = Object.keys(rows[0]);
          const colList = columns.join(', ');
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const insertSql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

          for (const row of rows) {
            const values = columns.map(c => row[c]);
            await client.query(insertSql, values);
            totalInserted++;
          }
          console.log(`[NEON SYNC] Seeded ${rows.length} rows into ${table}`);
        }
        await client.query('COMMIT');
        stats.recordsMigrated = totalInserted;
        console.log(`[NEON SYNC] Transactional seed commit complete (${totalInserted} total rows).`);
      } catch (seedErr) {
        await client.query('ROLLBACK');
        console.error('[NEON SYNC ERROR] Seed transaction failed:', seedErr);
        throw seedErr;
      }
    }

    // 4. Verify Owner Account in Neon
    const ownerRes = await client.query(
      "SELECT id, mobile_number, role, pin_length, (pin_hash IS NOT NULL) as has_hash FROM users WHERE mobile_number = '9356755100'"
    );
    if (ownerRes.rows.length > 0 && ownerRes.rows[0].role === 'admin') {
      stats.ownerVerified = true;
      console.log(`[NEON SYNC] Owner verified in Neon: ${ownerRes.rows[0].mobile_number} (${ownerRes.rows[0].id}) role=admin`);
    } else {
      console.warn('[NEON SYNC WARN] Owner account 9356755100 not found or not admin in Neon.');
    }

    // 5. Populate local SQLite from authoritative Neon PostgreSQL
    console.log('[NEON SYNC] Hydrating local SQLite database from Neon PostgreSQL...');
    for (const table of TABLES_IN_ORDER) {
      const res = await client.query(`SELECT * FROM ${table}`);
      if (res.rows.length > 0) {
        const columns = Object.keys(res.rows[0]);
        const colList = columns.join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const insertSql = `INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`;
        const insertStmt = db.prepare(insertSql);

        const insertMany = db.transaction((rows: any[]) => {
          for (const row of rows) {
            const vals = columns.map(c => {
              const v = row[c];
              if (v instanceof Date) {
                return v.toISOString();
              }
              return v;
            });
            insertStmt.run(...vals);
          }
        });

        insertMany(res.rows);
        console.log(`[NEON SYNC] Hydrated ${res.rows.length} records into local table ${table}`);
      }
    }

    // 6. Attach write-mirroring interceptor to db.prepare
    attachNeonWriteMirror(db, pool);
    activePgPool = pool;
    console.log('[NEON SYNC] Write-mirroring to Neon PostgreSQL active.');
  } finally {
    client.release();
  }

  return stats;
}

function attachNeonWriteMirror(db: Database.Database, pool: pg.Pool): void {
  const origPrepare = db.prepare.bind(db);

  db.prepare = function(sql: string): any {
    const stmt = origPrepare(sql);
    const trimmed = sql.trim().toUpperCase();
    const isMutation = trimmed.startsWith('INSERT') || trimmed.startsWith('UPDATE') || trimmed.startsWith('DELETE');

    if (!isMutation) {
      return stmt;
    }

    const origRun = stmt.run.bind(stmt);
    stmt.run = function(...params: any[]): Database.RunResult {
      // Execute synchronously on SQLite first
      const result = origRun(...params);

      // Asynchronously mirror mutation to Neon PostgreSQL
      const pgSql = convertQuestionMarksToDollarParams(sql);
      pool.query(pgSql, params).catch((err: any) => {
        console.error('[NEON WRITE-MIRROR ERROR]:', err.message, '\nSQL:', pgSql);
      });

      return result;
    };

    return stmt;
  };
}

export async function closePostgresSync(): Promise<void> {
  if (activePgPool) {
    try {
      await activePgPool.end();
    } catch {
      // ignore
    }
    activePgPool = null;
  }
}
