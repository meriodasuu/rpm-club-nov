import pg from 'pg';
import { poolConfig } from './config';

export interface Db { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> }
let pool: pg.Pool | undefined;
function getPool() {
  return pool ??= new pg.Pool(poolConfig(process.env));
}
export async function query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, values)).rows as T[];
}
export async function transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work({ query: async <R>(sql: string, values: unknown[] = []) => (await client.query(sql, values)).rows as R[] });
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function closePool() { if (pool) { await pool.end(); pool = undefined; } }
