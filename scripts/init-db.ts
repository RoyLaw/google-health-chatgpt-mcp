import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = await readFile(resolve(process.cwd(), 'sql/schema.sql'), 'utf8');
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  await pool.query(sql);
  console.log('Database schema initialized');
} finally {
  await pool.end();
}
