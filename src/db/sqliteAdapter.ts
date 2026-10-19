import type Database from 'better-sqlite3';
import type { IDatabase, QueryResult } from './adapter.js';

export class SqliteDatabase implements IDatabase {
  public rawDb: Database.Database;

  constructor(db: Database.Database) {
    this.rawDb = db;
  }

  isPostgres(): boolean {
    return false;
  }

  // Backward-compatibility delegation for tests calling db.prepare(...) directly
  prepare(sql: string): any {
    return this.rawDb.prepare(sql);
  }

  exec(sql: string): any {
    return this.rawDb.exec(sql);
  }

  pragma(pragma: string): any {
    return this.rawDb.pragma(pragma);
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const rows = this.rawDb.prepare(sql).all(...params);
    return rows as T[];
  }

  async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const row = this.rawDb.prepare(sql).get(...params);
    return (row as T) || null;
  }

  async execute(sql: string, params: any[] = []): Promise<QueryResult> {
    const result = this.rawDb.prepare(sql).run(...params);
    return { rowCount: result.changes };
  }

  async transaction<T>(fn: (tx: IDatabase) => Promise<T>): Promise<T> {
    // SQLite transaction runs in WAL mode
    const runTx = this.rawDb.transaction(() => {
      // Return a promise runner
      return fn(this);
    });
    return runTx();
  }

  async close(): Promise<void> {
    try {
      this.rawDb.close();
    } catch {
      // ignore
    }
  }
}
