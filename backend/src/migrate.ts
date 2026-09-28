import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export function codeMigrations() {
  return fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
    .map((f) => ({ version: Number(f.split('_')[0]), file: f }));
}
export const codeSchemaVersion = () => Math.max(0, ...codeMigrations().map((m) => m.version));

/** Idempotent: applies only migrations not yet recorded, each in its own transaction, under an advisory lock. */
export async function migrate(db: Db, log = console.log) {
  await db.query('SELECT pg_advisory_lock(7231001)');
  try {
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await db.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const m of codeMigrations()) {
      if (done.has(m.version)) continue;
      const sql = fs.readFileSync(path.join(dir, m.file), 'utf8');
      await db.query('BEGIN');
      try {
        await db.query(sql);
        await db.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.file]);
        await db.query('COMMIT');
        log(`[migrate] applied ${m.file}`);
      } catch (e) { await db.query('ROLLBACK'); throw e; }
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(7231001)');
  }
}

export async function dbSchemaVersion(db: Db): Promise<number> {
  const exists = (await db.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t;
  if (!exists) return 0;
  return (await db.query('SELECT coalesce(max(version), 0) AS v FROM schema_migrations')).rows[0].v;
}
