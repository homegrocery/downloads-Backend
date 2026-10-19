import pg from 'pg';
import type { IDatabase, QueryResult } from './adapter.js';

const { Pool } = pg;

export function convertQuestionMarksToDollarParams(sql: string): string {
  let paramIndex = 0;
  return sql.replace(/\?/g, () => `$${++paramIndex}`);
}

export class PostgresDatabase implements IDatabase {
  private pool: pg.Pool;

  constructor(connectionStringOrConfig: string | pg.PoolConfig) {
    if (typeof connectionStringOrConfig === 'string') {
      const isLocal = connectionStringOrConfig.includes('localhost') || connectionStringOrConfig.includes('127.0.0.1');
      this.pool = new Pool({
        connectionString: connectionStringOrConfig,
        ssl: isLocal ? false : { rejectUnauthorized: false }
      });
    } else {
      this.pool = new Pool(connectionStringOrConfig);
    }
  }

  isPostgres(): boolean {
    return true;
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const pgSql = convertQuestionMarksToDollarParams(sql);
    const result = await this.pool.query(pgSql, params);
    return result.rows as T[];
  }

  async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql: string, params: any[] = []): Promise<QueryResult> {
    const pgSql = convertQuestionMarksToDollarParams(sql);
    const result = await this.pool.query(pgSql, params);
    return { rowCount: result.rowCount || 0 };
  }

  async transaction<T>(fn: (tx: IDatabase) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txAdapter: IDatabase = {
        isPostgres: () => true,
        query: async <R = any>(sql: string, params: any[] = []): Promise<R[]> => {
          const pgSql = convertQuestionMarksToDollarParams(sql);
          const result = await client.query(pgSql, params);
          return result.rows as R[];
        },
        queryOne: async <R = any>(sql: string, params: any[] = []): Promise<R | null> => {
          const pgSql = convertQuestionMarksToDollarParams(sql);
          const result = await client.query(pgSql, params);
          return (result.rows[0] as R) || null;
        },
        execute: async (sql: string, params: any[] = []): Promise<QueryResult> => {
          const pgSql = convertQuestionMarksToDollarParams(sql);
          const result = await client.query(pgSql, params);
          return { rowCount: result.rowCount || 0 };
        },
        transaction: async <R>(subFn: (subTx: IDatabase) => Promise<R>): Promise<R> => {
          return subFn(txAdapter);
        },
        close: async (): Promise<void> => {
          // Client release handled by outer transaction
        }
      };

      const result = await fn(txAdapter);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
