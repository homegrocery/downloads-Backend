import { Router } from 'express';
import { config } from '../config.js';
import { getDatabase } from '../db/database.js';

export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  const dbUrl = process.env.DATABASE_URL || config.databaseUrl || '';
  const isPostgresConfigured = Boolean(dbUrl && dbUrl.trim());
  const dbStatus = {
    type: isPostgresConfigured ? 'postgres' : 'sqlite',
    configured: isPostgresConfigured,
    connected: false,
    error: null as string | null
  };

  if (isPostgresConfigured) {
    try {
      const { default: pg } = await import('pg');
      const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
      const pool = new pg.Pool({
        connectionString: dbUrl,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000
      });
      const client = await pool.connect();
      const result = await client.query('SELECT 1 as alive');
      const tablesRes = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;");
      client.release();
      await pool.end();
      dbStatus.connected = result.rows.length > 0;
      (dbStatus as any).tables = tablesRes.rows.map(r => r.table_name);
    } catch (err: any) {
      dbStatus.connected = false;
      dbStatus.error = err.message;
    }
  } else {
    try {
      const db = getDatabase();
      const row = db.prepare('SELECT 1 as alive').get() as { alive: number } | undefined;
      dbStatus.connected = row?.alive === 1;
    } catch (err: any) {
      dbStatus.connected = false;
      dbStatus.error = err.message;
    }
  }

  res.json({
    status: dbStatus.connected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    service: config.appName,
    serviceMr: config.appNameMr,
    database: dbStatus
  });
});

healthRouter.get('/version', (req, res) => {
  res.json({
    name: config.appName,
    nameMr: config.appNameMr,
    version: config.appVersion,
    buildNumber: config.buildNumber,
    attribution: config.attribution
  });
});
