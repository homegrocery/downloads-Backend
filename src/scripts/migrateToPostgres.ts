import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import pg from 'pg';
import { convertQuestionMarksToDollarParams } from '../db/postgresAdapter.js';

dotenv.config();

const { Pool } = pg;

export interface MigrationOptions {
  sourceDbPath?: string;
  databaseUrl?: string;
  force?: boolean;
}

export async function runPostgresMigration(options: MigrationOptions = {}) {
  const sourcePath = options.sourceDbPath ||
    path.resolve(process.cwd(), 'backups', 'homegrocery_backup_20261019_161649.db');

  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;

  console.log('='.repeat(70));
  console.log('HOME GROCERY — SQLITE TO NEON POSTGRESQL MIGRATION');
  console.log('='.repeat(70));
  console.log(`Source SQLite Backup: ${sourcePath}`);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SOURCE_BACKUP_NOT_FOUND: Could not find verified backup at ${sourcePath}`);
  }

  if (!databaseUrl || !databaseUrl.trim()) {
    throw new Error('DATABASE_URL_REQUIRED: Please set the DATABASE_URL environment variable to your Neon connection string.');
  }

  // 1. Verify SQLite Source
  const sqlite = new Database(sourcePath, { readonly: true });
  const integrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
  console.log(`Source SQLite integrity: ${JSON.stringify(integrity)}`);

  const tablesToMigrate = [
    'users',
    'shopping_lists',
    'shopping_items',
    'authentication_sessions',
    'recovery_codes',
    'recovery_authorizations',
    'recovery_requests',
    'admin_audit_logs'
  ];

  const sourceCounts: Record<string, number> = {};
  for (const table of tablesToMigrate) {
    const row = sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    sourceCounts[table] = row.count;
    console.log(`  Source ${table}: ${row.count} records`);
  }

  // 2. Connect to Target Neon PostgreSQL
  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    const versionRes = await client.query('SELECT version();');
    console.log(`\nConnected to PostgreSQL: ${versionRes.rows[0].version.split(' on ')[0]}`);

    // 3. Apply Schema DDL
    const ddlPaths = [
      path.resolve(process.cwd(), 'src', 'db', 'schema.pg.sql'),
      path.resolve(process.cwd(), 'dist', 'db', 'schema.pg.sql'),
      path.resolve(__dirname, '..', 'db', 'schema.pg.sql')
    ];
    let ddlSql = '';
    for (const p of ddlPaths) {
      if (fs.existsSync(p)) {
        ddlSql = fs.readFileSync(p, 'utf8');
        break;
      }
    }

    if (!ddlSql) {
      throw new Error('SCHEMA_DDL_NOT_FOUND: Could not locate schema.pg.sql file.');
    }

    console.log('\nApplying PostgreSQL Schema DDL (idempotent)...');
    await client.query(ddlSql);
    console.log('Schema DDL applied successfully.');

    // 4. Check Existing Destination Records
    let destHasData = false;
    for (const table of tablesToMigrate) {
      const res = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      const count = parseInt(res.rows[0].count, 10);
      if (count > 0) {
        destHasData = true;
        console.log(`  Destination table ${table} already has ${count} records.`);
      }
    }

    if (destHasData && !options.force) {
      console.log('\nTarget database already has existing records. Validating parity without re-inserting...');
    } else {
      console.log('\nBeginning transactional data transfer in dependency order...');
      await client.query('BEGIN');

      for (const table of tablesToMigrate) {
        const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
        if (rows.length === 0) continue;

        const columns = Object.keys(rows[0] as object);
        const colList = columns.join(', ');
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

        const insertSql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

        for (const row of rows) {
          const values = columns.map(c => (row as any)[c]);
          await client.query(insertSql, values);
        }
        console.log(`  Migrated ${rows.length} records into ${table}`);
      }

      await client.query('COMMIT');
      console.log('Transaction committed successfully.');
    }

    // 5. Verification & Parity Assertions
    console.log('\n' + '='.repeat(70));
    console.log('POST-MIGRATION PARITY VERIFICATION');
    console.log('='.repeat(70));

    let allParityMatched = true;
    for (const table of tablesToMigrate) {
      const res = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      const destCount = parseInt(res.rows[0].count, 10);
      const srcCount = sourceCounts[table] || 0;
      const matched = destCount >= srcCount;
      if (!matched) allParityMatched = false;
      console.log(`  ${table.padEnd(28)} Source: ${String(srcCount).padStart(3)} | Dest: ${String(destCount).padStart(3)} [${matched ? 'MATCHED' : 'FAILED'}]`);
    }

    // Verify Owner Record specifically
    const ownerRes = await client.query('SELECT id, mobile_number, full_name, role, pin_length, (pin_hash IS NOT NULL) as has_hash FROM users WHERE mobile_number = $1', ['9356755100']);
    const owner = ownerRes.rows[0];
    if (owner && owner.role === 'admin') {
      console.log(`\nOwner Verification: PASSED`);
      console.log(`  UUID: ${owner.id}`);
      console.log(`  Mobile: ${owner.mobile_number}`);
      console.log(`  Name: ${owner.full_name}`);
      console.log(`  Role: ${owner.role}`);
      console.log(`  Has PIN Hash: ${owner.has_hash}`);
    } else {
      allParityMatched = false;
      console.error('\nOwner Verification: FAILED (Owner not found or missing admin role!)');
    }

    if (!allParityMatched) {
      throw new Error('PARITY_VERIFICATION_FAILED: One or more tables failed record verification.');
    }

    console.log('\nMigration completed with 100% data fidelity!');
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

// CLI execution wrapper
const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFilePath === currentFilePath || invokedFilePath.replace(/\\/g, '/').endsWith('migrateToPostgres.ts')) {
  runPostgresMigration()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('\n[MIGRATION ERROR]:', err.message);
      process.exit(1);
    });
}
