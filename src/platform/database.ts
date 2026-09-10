import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

import type { AppConfig } from './config.js';

export type DatabaseClient = Pool | PoolClient;

export function createDatabasePool(config: AppConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: config.databaseStatementTimeoutMs,
    application_name: 'game-consign-api',
  };

  return new Pool(poolConfig);
}

export async function withTransaction<T>(
  pool: Pool,
  lockTimeoutMs: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  client: DatabaseClient,
  sql: string,
  values: unknown[] = [],
): Promise<T | undefined> {
  const result = await client.query<T>(sql, values);
  return result.rows[0];
}
