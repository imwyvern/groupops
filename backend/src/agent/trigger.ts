/**
 * A5.1 triggering. Both paths below take a per-group advisory lock, so "is a run
 * active?" and "create a run / park the message" are atomic with respect to each
 * other and to a run finishing — on any number of instances. The partial unique
 * index agent_runs_one_running is the backstop.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { queueEvent } from '../db.js';

export interface TriggerMessage { msgId: string; senderPlatformUserId: string; text: string; sentAt: string }

export const lockGroup = (c: pg.PoolClient, groupId: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent:${groupId}`]);

export async function onInboundMessage(c: pg.PoolClient, groupId: string, msg: TriggerMessage) {
  await lockGroup(c, groupId);
  const running = await c.query(`SELECT id FROM agent_runs WHERE group_id = $1 AND status = 'running'`, [groupId]);
  if (running.rowCount) {
    await c.query('INSERT INTO agent_pending (group_id, msg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, msg.msgId]);
    return;
  }
  await createRun(c, groupId, [msg]);
}

export async function createRun(c: pg.PoolClient, groupId: string, triggerMessages: TriggerMessage[]) {
  const id = randomUUID();
  const own = await c.query('SELECT platform_user_id FROM accounts WHERE platform_user_id IS NOT NULL ORDER BY id');
  const group = await c.query('SELECT auto_kick_enabled FROM groups WHERE id = $1', [groupId]);
  const context = {
    groupId,
    triggerMessages: [...triggerMessages].sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
    policy: { autoKickEnabled: group.rows[0].auto_kick_enabled },
    ownPlatformUserIds: own.rows.map((r) => r.platform_user_id),
  };
  const history = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(context) }] }];
  await c.query(
    `INSERT INTO agent_runs (id, group_id, trigger_messages, history) VALUES ($1, $2, $3, $4)`,
    [id, groupId, JSON.stringify(context.triggerMessages), JSON.stringify(history)]);
  queueEvent(c, 'agent_run', { runId: id, groupId, status: 'running', endReason: null });
  return id;
}

/** Called in the transaction that ends a run: start the next run with everything that queued up. */
export async function startNextRunIfPending(c: pg.PoolClient, groupId: string) {
  await lockGroup(c, groupId);
  const g = (await c.query('SELECT status, agent_enabled FROM groups WHERE id = $1', [groupId])).rows[0];
  const pending = await c.query(
    `DELETE FROM agent_pending p USING messages m
      WHERE p.group_id = $1 AND m.group_id = p.group_id AND m.msg_id = p.msg_id
      RETURNING m.msg_id, m.sender_platform_user_id, m.text, m.sent_at`, [groupId]);
  if (!pending.rowCount || g.status !== 'active' || !g.agent_enabled) return null;
  return createRun(c, groupId, pending.rows.map((r) => ({
    msgId: r.msg_id, senderPlatformUserId: r.sender_platform_user_id, text: r.text, sentAt: new Date(r.sent_at).toISOString(),
  })));
}
