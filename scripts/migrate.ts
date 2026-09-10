import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../src/platform/config.js';
import { createDatabasePool } from '../src/platform/database.js';

const config = loadConfig();
const pool = createDatabasePool(config);

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const directory = resolve(process.cwd(), 'migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('game-consign-schema-migrations'))",
      );
      const exists = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists',
        [file],
      );
      if (exists.rows[0]?.exists) {
        await client.query('COMMIT');
        console.log(`skip ${file}`);
        continue;
      }

      const sql = await readFile(resolve(directory, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
