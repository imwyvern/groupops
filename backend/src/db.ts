import pg from 'pg';
import { config } from './config.js';

// timestamptz → keep as Date; bigint (int8) → number (our ids stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export type Db = pg.Pool | pg.PoolClient;

/** Run `fn` in a transaction. Callbacks registered via `afterCommit` fire only if COMMIT succeeds. */
export async function tx<T>(fn: (c: pg.PoolClient, afterCommit: (cb: () => void) => void) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const hooks: (() => void)[] = [];
  try {
    await c.query('BEGIN');
    const out = await fn(c, (cb) => hooks.push(cb));
    await flushEvents(c);
    await c.query('COMMIT');
    for (const h of hooks) h();
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * WebSocket events are appended to `ws_events` inside the transaction that
 * produced the state change, so a pushed event always describes committed state.
 * The advisory lock is taken last (just before COMMIT) and makes seq order
 * equal commit order, so a reader following `seq` never skips a late commit.
 */
export function queueEvent(c: pg.PoolClient, type: string, payload: Record<string, unknown>) {
  ((c as any).__events ??= []).push({ type, payload });
}
async function flushEvents(c: pg.PoolClient) {
  const evts: { type: string; payload: unknown }[] = (c as any).__events ?? [];
  (c as any).__events = [];
  if (!evts.length) return;
  await c.query('SELECT pg_advisory_xact_lock(7231002)');
  for (const e of evts) await c.query('INSERT INTO ws_events (type, payload) VALUES ($1, $2)', [e.type, e.payload]);
  await c.query("SELECT pg_notify('ws_events', '')");
}
