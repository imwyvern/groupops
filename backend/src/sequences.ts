/**
 * Timed sequences (B1).
 *  - Placeholder resolution is a pure function, shared by the precheck endpoint and by
 *    run creation, so what the operator previews is exactly what gets sent.
 *  - "At most one running run per group" is a partial unique index; two concurrent
 *    starts race on it and exactly one wins (S7).
 *  - Scheduling is data: only the current step has `scheduled_at`; the next one is
 *    stamped when this one is "发出" (message_sent / skipped), see domain.advanceSequence.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool, tx, queueEvent } from './db.js';
import { enqueueMessage } from './outbox.js';
import { advanceSequence } from './domain.js';

export interface SeqStep { index: number; accountRole: 'admin' | 'member'; text: string; delaySeconds: number }
export interface ResolvedStep extends SeqStep { resolvedText: string; resolvedVars: Record<string, string>; varSources: Record<string, string> }
export type ResolveResult = { ok: true; steps: ResolvedStep[] } | { ok: false; stepIndex: number; key: string };

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

export function resolveSequence(steps: SeqStep[], vars: Record<string, string> = {}, stepVars: Record<string, Record<string, string>> = {}): ResolveResult {
  // Null-prototype maps: `{constructor}` must be "unresolved", not Object.prototype.constructor.
  const value: Record<string, string> = Object.create(null);
  const source: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(vars)) if (v !== '') { value[k] = String(v); source[k] = 'default'; } // "" in vars = not provided
  const out: ResolvedStep[] = [];
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    for (const [k, v] of Object.entries(stepVars[String(step.index)] ?? {})) {
      if (v === '') continue; // "" in stepVars = this step does not change it
      value[k] = String(v); source[k] = `step:${step.index}`;
    }
    const resolvedVars: Record<string, string> = {};
    const varSources: Record<string, string> = {};
    for (const [, key] of step.text.matchAll(PLACEHOLDER)) {
      if (!Object.hasOwn(value, key)) return { ok: false, stepIndex: step.index, key };
      resolvedVars[key] = value[key];
      varSources[key] = source[key];
    }
    out.push({ ...step, resolvedText: step.text.replace(PLACEHOLDER, (_, k) => value[k]), resolvedVars, varSources });
  }
  return { ok: true, steps: out };
}

export function validateSequence(body: any): string | null {
  if (!body || typeof body.name !== 'string' || !body.name) return 'name is required';
  if (!Array.isArray(body.steps) || !body.steps.length) return 'steps must be a non-empty array';
  const seen = new Set<number>();
  for (const s of body.steps) {
    if (!Number.isInteger(s?.index) || s.index < 1 || seen.has(s.index)) return 'each step needs a unique positive integer index';
    seen.add(s.index);
    if (s.accountRole !== 'admin' && s.accountRole !== 'member') return `step ${s.index}: accountRole must be admin or member`;
    if (typeof s.text !== 'string' || !s.text) return `step ${s.index}: text is required`;
    if (!Number.isInteger(s.delaySeconds) || s.delaySeconds < 0) return `step ${s.index}: delaySeconds must be a non-negative integer`;
  }
  return null;
}

/** Returns the run id, or throws { code } for 409/422 mapping by the route. */
export async function startSequenceRun(c: pg.PoolClient, groupId: string, sequence: { id: string; steps: SeqStep[] }, resolved: ResolvedStep[]) {
  const runId = randomUUID();
  const first = resolved[0];
  await c.query(`INSERT INTO sequence_runs (id, group_id, sequence_id, current_step_index) VALUES ($1, $2, $3, $4)`, [runId, groupId, sequence.id, first.index]);
  for (const s of resolved) {
    await c.query(
      `INSERT INTO sequence_run_steps (run_id, idx, account_role, text, delay_seconds, scheduled_at, resolved_vars, var_sources)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $8 THEN now() + make_interval(secs => $5::int) END, $6, $7)`,
      [runId, s.index, s.accountRole, s.resolvedText, s.delaySeconds, JSON.stringify(s.resolvedVars), JSON.stringify(s.varSources), s === first]);
  }
  queueEvent(c, 'sequence_run', { runId, groupId, status: 'running', currentStepIndex: first.index });
  return runId;
}

// ------------------------------------------------------------------ scheduler

export async function startSequenceScheduler() {
  // Restart rule: only the earliest overdue step is re-planned (restart time + its own delay);
  // later steps keep their "after the previous one was sent" schedule, so nothing bursts out.
  await pool.query(`
    UPDATE sequence_run_steps s SET scheduled_at = now() + make_interval(secs => s.delay_seconds)
      FROM sequence_runs r
     WHERE r.id = s.run_id AND r.status = 'running' AND s.idx = r.current_step_index
       AND s.status = 'pending' AND s.client_msg_id IS NULL AND s.scheduled_at < now()`);
  setInterval(() => tick().catch((e) => console.error('[sequence]', e)), 250).unref();
}

async function tick() {
  await tx(async (c) => {
    const { rows } = await c.query(`
      SELECT s.run_id, s.idx, s.account_role, s.text, r.group_id
        FROM sequence_run_steps s JOIN sequence_runs r ON r.id = s.run_id
       WHERE r.status = 'running' AND s.idx = r.current_step_index AND s.status = 'pending'
         AND s.client_msg_id IS NULL AND s.scheduled_at <= now()
       FOR UPDATE OF s SKIP LOCKED`);
    for (const step of rows) await fire(c, step);
  });
}

/**
 * admin: role creator/admin, online, admin preferred. member: role member, online, lowest accountId.
 * A matching account that is merely rate_limited means "wait", not "skip" (B1).
 */
async function fire(c: pg.PoolClient, step: any) {
  const roles = step.account_role === 'admin' ? ['admin', 'creator'] : ['member'];
  const { rows } = await c.query(
    `SELECT a.id, a.status, a.platform_user_id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
      WHERE gm.group_id = $1 AND gm.role = ANY($2) AND a.status IN ('online', 'rate_limited')
      ORDER BY array_position($2, gm.role), a.id`, [step.group_id, roles]);
  const online = rows.find((r) => r.status === 'online');
  if (!online && rows.length) return; // only rate-limited candidates: try again next tick
  if (!online) {
    await c.query(`UPDATE sequence_run_steps SET status = 'skipped', sent_at = now() WHERE run_id = $1 AND idx = $2`, [step.run_id, step.idx]);
    return advanceSequence(c, step.run_id, step.group_id, step.idx);
  }
  const clientMsgId = `sq-${step.run_id}-${step.idx}`;
  await c.query(`UPDATE sequence_run_steps SET client_msg_id = $3 WHERE run_id = $1 AND idx = $2`, [step.run_id, step.idx, clientMsgId]);
  await enqueueMessage(c, { groupId: step.group_id, accountId: online.id, platformUserId: online.platform_user_id, clientMsgId, text: step.text, source: 'sequence' });
}
