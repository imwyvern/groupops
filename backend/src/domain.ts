/**
 * Cross-cutting state changes. Every function here takes an open transaction
 * client: the state change, all of its consequences, and the WebSocket events
 * describing them commit together or not at all (spec A1 "要么都生效，要么都不生效").
 */
import type pg from 'pg';
import { queueEvent } from './db.js';

export type AccountStatus = 'idle' | 'online' | 'rate_limited' | 'disconnected' | 'suspended' | 'session_expired';
export const ACCOUNT_STATUSES: AccountStatus[] = ['idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired'];
export const TERMINAL = new Set<AccountStatus>(['suspended', 'session_expired']);

/** Spec A1 transition table (row = from, list = allowed targets). Same-state is never allowed. */
export const TRANSITIONS: Record<AccountStatus, AccountStatus[]> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};
export const isLegal = (from: AccountStatus, to: AccountStatus) => TRANSITIONS[from]?.includes(to) ?? false;

export type TransitionResult = { ok: true; from: AccountStatus } | { ok: false; code: 'ACCOUNT_NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'CAS_CONFLICT'; current?: AccountStatus };

/**
 * Compare-and-set transition. The UPDATE's WHERE clause is the CAS: of two concurrent
 * callers expecting the same `from`, exactly one matches a row; the other gets CAS_CONFLICT.
 */
export async function transitionAccount(
  c: pg.PoolClient, accountId: string, expectedFrom: AccountStatus, to: AccountStatus,
  set: { platformUserId?: string; rateLimitedForSec?: number } = {},
): Promise<TransitionResult> {
  if (!isLegal(expectedFrom, to)) {
    const exists = await c.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
    return { ok: false, code: exists.rowCount ? 'ILLEGAL_TRANSITION' : 'ACCOUNT_NOT_FOUND' };
  }
  const { rows } = await c.query(
    `UPDATE accounts SET status = $3, version = version + 1, updated_at = now(),
            platform_user_id = coalesce($4, platform_user_id),
            rate_limited_until = CASE WHEN $3 = 'rate_limited' THEN now() + make_interval(secs => $5::float8) ELSE NULL END
      WHERE id = $1 AND status = $2 RETURNING id`,
    [accountId, expectedFrom, to, set.platformUserId ?? null, set.rateLimitedForSec ?? null]);
  if (!rows[0]) {
    const cur = await c.query('SELECT status FROM accounts WHERE id = $1', [accountId]);
    return cur.rowCount ? { ok: false, code: 'CAS_CONFLICT', current: cur.rows[0].status } : { ok: false, code: 'ACCOUNT_NOT_FOUND' };
  }
  queueEvent(c, 'account_status_changed', { accountId, from: expectedFrom, to });
  if (TERMINAL.has(to)) await applyTerminalConsequences(c, accountId, to);
  return { ok: true, from: expectedFrom };
}

/**
 * Enter a terminal state from any source (send error, gateway event, operator).
 * Re-entering a terminal state (same or the other one) is silently ignored.
 */
export async function enterTerminal(c: pg.PoolClient, accountId: string, status: 'suspended' | 'session_expired') {
  const { rows } = await c.query('SELECT status FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  if (!rows[0] || TERMINAL.has(rows[0].status)) return false;
  await transitionAccount(c, accountId, rows[0].status, status);
  return true;
}

async function applyTerminalConsequences(c: pg.PoolClient, accountId: string, status: AccountStatus) {
  // 1. out of every group
  const left = await c.query('DELETE FROM group_members WHERE account_id = $1 RETURNING group_id', [accountId]);
  for (const r of left.rows) queueEvent(c, 'member_changed', { groupId: r.group_id });
  // 2. queued sends are cancelled (in-flight/unknown ones are resolved by the outbox against the gateway)
  const cancelled = await c.query(
    `UPDATE messages SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL'
      WHERE account_id = $1 AND delivery_status = 'queued' AND attempt_started_at IS NULL
      RETURNING group_id, client_msg_id`, [accountId]);
  for (const m of cancelled.rows) {
    queueEvent(c, 'message_status', { groupId: m.group_id, clientMsgId: m.client_msg_id, deliveryStatus: 'cancelled' });
    // 3. the sequence step that owned the message is skipped
    await onSequenceMessageOutcome(c, m.client_msg_id, 'cancelled');
  }
  queueEvent(c, 'account_terminal', { accountId, status });
}

/**
 * RATE_LIMITED from the gateway. Refreshing `rateLimitedUntil` while already limited is not a transition.
 * Deadlines use the database clock only (never JS time compared to now()), plus a small margin so
 * that clock skew between us and the gateway can't make us send a moment too early — which would
 * restart the gateway's window.
 */
const RATE_LIMIT_MARGIN_SEC = 0.5;
/**
 * In-process hold on a monotonic clock. Wall clocks can be stepped (NTP, a VM re-syncing: the
 * dev Postgres VM here jumps by >1s every few seconds), which would end a 2s window early and
 * reset the gateway's timer. The persisted deadline covers restarts; while this process is alive,
 * release additionally waits for the monotonic hold.
 */
const monotonicHold = new Map<string, number>();
export async function rateLimit(c: pg.PoolClient, accountId: string, retryAfterSeconds: number) {
  const secs = Math.max(1, retryAfterSeconds) + RATE_LIMIT_MARGIN_SEC;
  monotonicHold.set(accountId, performance.now() + secs * 1000);
  const { rows } = await c.query('SELECT status FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  const cur = rows[0]?.status as AccountStatus | undefined;
  if (cur === 'online') await transitionAccount(c, accountId, 'online', 'rate_limited', { rateLimitedForSec: secs });
  else if (cur === 'rate_limited') await c.query('UPDATE accounts SET rate_limited_until = now() + make_interval(secs => $2::float8) WHERE id = $1', [accountId, secs]);
}

/** Expired rate limits go back to online — only if the account is still rate_limited (A1 last rule). */
export async function releaseExpiredRateLimits(c: pg.PoolClient) {
  const { rows } = await c.query(
    `SELECT id FROM accounts WHERE status = 'rate_limited' AND rate_limited_until <= now() FOR UPDATE SKIP LOCKED`);
  let released = 0;
  for (const r of rows) {
    const hold = monotonicHold.get(r.id);
    if (hold !== undefined && performance.now() < hold) continue;
    monotonicHold.delete(r.id);
    await transitionAccount(c, r.id, 'rate_limited', 'online');
    released++;
  }
  return released;
}

/**
 * GROUP_WRITE_FORBIDDEN: the group becomes unreachable, its sequence runs stop,
 * queued sends to it fail, pending agent triggers are dropped. A running agent run
 * notices at its next step boundary and ends as `cancelled`.
 */
export async function markGroupUnreachable(c: pg.PoolClient, groupId: string) {
  const { rowCount } = await c.query(`UPDATE groups SET status = 'unreachable' WHERE id = $1 AND status = 'active'`, [groupId]);
  if (!rowCount) return;
  queueEvent(c, 'group_changed', { groupId });
  const runs = await c.query(
    `UPDATE sequence_runs SET status = 'stopped', updated_at = now() WHERE group_id = $1 AND status = 'running'
      RETURNING id, current_step_index`, [groupId]);
  for (const r of runs.rows) queueEvent(c, 'sequence_run', { runId: r.id, groupId, status: 'stopped', currentStepIndex: r.current_step_index });
  const failed = await c.query(
    `UPDATE messages SET delivery_status = 'failed', fail_code = 'GROUP_UNREACHABLE'
      WHERE group_id = $1 AND delivery_status = 'queued' AND attempt_started_at IS NULL RETURNING client_msg_id`, [groupId]);
  for (const m of failed.rows) queueEvent(c, 'message_status', { groupId, clientMsgId: m.client_msg_id, deliveryStatus: 'failed' });
  await c.query('DELETE FROM agent_pending WHERE group_id = $1', [groupId]);
}

// ---------------------------------------------------------------------------
// Sequence step progression (B1). Lives here because both the outbox and the
// terminal cascade drive it.
// ---------------------------------------------------------------------------

export type MessageOutcome = 'accepted' | 'sent' | 'failed' | 'cancelled';

export async function onSequenceMessageOutcome(c: pg.PoolClient, clientMsgId: string, outcome: MessageOutcome) {
  const { rows } = await c.query(
    `SELECT s.run_id, s.idx, s.status, r.group_id, r.status AS run_status
       FROM sequence_run_steps s JOIN sequence_runs r ON r.id = s.run_id
      WHERE s.client_msg_id = $1 FOR UPDATE OF s`, [clientMsgId]);
  const step = rows[0];
  if (!step || step.run_status !== 'running') return;
  if (outcome === 'accepted') {
    if (step.status === 'pending') await c.query(`UPDATE sequence_run_steps SET status = 'accepted' WHERE run_id = $1 AND idx = $2`, [step.run_id, step.idx]);
    return;
  }
  if (!['pending', 'accepted'].includes(step.status)) return;
  const status = outcome === 'sent' ? 'sent' : outcome === 'cancelled' ? 'skipped' : 'failed';
  await c.query(`UPDATE sequence_run_steps SET status = $3, sent_at = now() WHERE run_id = $1 AND idx = $2`, [step.run_id, step.idx, status]);
  await advanceSequence(c, step.run_id, step.group_id, step.idx);
}

/** Step `doneIdx` just completed ("发出" = now): schedule the next one relative to now, or finish the run. */
export async function advanceSequence(c: pg.PoolClient, runId: string, groupId: string, doneIdx: number) {
  const next = await c.query(
    `SELECT idx, delay_seconds FROM sequence_run_steps WHERE run_id = $1 AND idx > $2 ORDER BY idx LIMIT 1`, [runId, doneIdx]);
  if (next.rows[0]) {
    await c.query(`UPDATE sequence_run_steps SET scheduled_at = now() + make_interval(secs => delay_seconds) WHERE run_id = $1 AND idx = $2`, [runId, next.rows[0].idx]);
    await c.query(`UPDATE sequence_runs SET current_step_index = $2, updated_at = now() WHERE id = $1`, [runId, next.rows[0].idx]);
    queueEvent(c, 'sequence_run', { runId, groupId, status: 'running', currentStepIndex: next.rows[0].idx });
    return;
  }
  const anyFailed = (await c.query(`SELECT 1 FROM sequence_run_steps WHERE run_id = $1 AND status = 'failed'`, [runId])).rowCount;
  const status = anyFailed ? 'failed' : 'finished';
  await c.query(`UPDATE sequence_runs SET status = $2, updated_at = now() WHERE id = $1`, [runId, status]);
  queueEvent(c, 'sequence_run', { runId, groupId, status, currentStepIndex: doneIdx });
}
