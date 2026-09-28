/**
 * Outbound message delivery (spec A2).
 *
 * Invariants and how they are kept:
 *  - "gateway sent it but we have no record": the row is INSERTed as `queued` before the
 *    gateway is ever called.
 *  - "one outbound row → several gateway messages": before calling `send` we stamp
 *    `attempt_started_at` (an atomic claim). A row that is claimed but has no outcome is,
 *    after a crash, treated exactly like a 504: its fate is resolved through
 *    by-client-id before any resend, and at most one resend is ever made.
 *  - per-account ordering: an account sends one message at a time, oldest first, so
 *    messages held back by a rate limit go out in their original order.
 */
import pg from 'pg';
import { pool, tx, queueEvent } from './db.js';
import { gateway, GatewayError } from './gateway.js';
import { enterTerminal, markGroupUnreachable, onSequenceMessageOutcome, rateLimit } from './domain.js';

const UNKNOWN_SETTLE_MS = 2_000; // gateway converges within 2s after a 504
/**
 * Monotonic start of each unknown window (this process only). A stepped wall clock must never
 * shorten the 2s settle — resending before the gateway has converged could produce a duplicate.
 * After a restart the persisted unknown_since is all we have (and the window has long passed).
 */
const unknownSinceMono = new Map<string, number>();
const SEND_TIMEOUT_MS = 8_000;   // our HTTP timeout on `send`; a crash-orphaned claim is judged after this

export async function enqueueMessage(c: pg.PoolClient, m: {
  groupId: string; accountId: string; platformUserId: string | null; clientMsgId: string; text: string; source: string;
}) {
  const { rows } = await c.query(
    `INSERT INTO messages (group_id, client_msg_id, sender_platform_user_id, account_id, is_own, text, sent_at, delivery_status, source)
     VALUES ($1, $2, $3, $4, true, $5, date_trunc('milliseconds', now()), 'queued', $6) RETURNING id`,
    [m.groupId, m.clientMsgId, m.platformUserId, m.accountId, m.text, m.source]);
  queueEvent(c, 'message', { groupId: m.groupId, msgId: null, clientMsgId: m.clientMsgId, isOwn: true });
  nudge();
  return rows[0].id as number;
}

// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;
export function nudge() { if (!running) setImmediate(tick); }

async function tick() {
  if (running) return;
  running = true;
  try {
    await cancelOrphanedByTerminal();
    await dispatch();
    await resolveUnknown();
  } catch (e) { console.error('[outbox]', e); }
  finally { running = false; }
}

export async function startOutbox() {
  // Crash recovery: a claimed row with no outcome is "result unknown".
  await pool.query(
    `UPDATE messages SET delivery_status = 'unknown',
            unknown_since = attempt_started_at + make_interval(secs => $1::int / 1000)
      WHERE delivery_status = 'queued' AND attempt_started_at IS NOT NULL`, [SEND_TIMEOUT_MS]);
  timer = setInterval(tick, 200);
  timer.unref();
}

/**
 * A message can return to `queued` after its account went terminal (e.g. the 504 resend path, or
 * a send that was in flight when the terminal cascade ran and was therefore skipped by it). Such a
 * row would never be dispatched again, so it gets the same outcome the cascade gives: cancelled.
 */
async function cancelOrphanedByTerminal() {
  await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE messages m SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL'
         FROM accounts a
        WHERE a.id = m.account_id AND a.status IN ('suspended', 'session_expired')
          AND m.delivery_status = 'queued' AND m.attempt_started_at IS NULL
        RETURNING m.group_id, m.client_msg_id`);
    for (const m of rows) {
      queueEvent(c, 'message_status', { groupId: m.group_id, clientMsgId: m.client_msg_id, deliveryStatus: 'cancelled' });
      await onSequenceMessageOutcome(c, m.client_msg_id, 'cancelled');
    }
  });
}

/** Head-of-line message per online account, if it is ready to go. */
async function dispatch() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (m.account_id) m.id, m.account_id, m.group_id, m.client_msg_id, m.text, m.delivery_status,
           m.attempt_started_at, (m.next_attempt_at IS NULL OR m.next_attempt_at <= now()) AS due,
           a.status AS account_status, g.gateway_group_id, g.status AS group_status
      FROM messages m
      JOIN accounts a ON a.id = m.account_id
      JOIN groups g ON g.id = m.group_id
     WHERE m.delivery_status IN ('queued', 'unknown')
     ORDER BY m.account_id, m.id`);
  await Promise.all(rows
    .filter((r) => r.delivery_status === 'queued' && !r.attempt_started_at && r.account_status === 'online'
      && r.due)
    .map(sendOne));
}

async function sendOne(m: any) {
  // Atomic claim: only one worker (on any instance) gets to call the gateway for this row.
  const claim = await pool.query(
    `UPDATE messages SET attempt_started_at = now() WHERE id = $1 AND delivery_status = 'queued' AND attempt_started_at IS NULL RETURNING id`, [m.id]);
  if (!claim.rowCount) return;
  try {
    await gateway.send(m.gateway_group_id, m.account_id, m.client_msg_id, m.text);
    await tx(async (c) => {
      // message_sent may already have arrived while `send` was still returning 202 — never downgrade.
      const r = await c.query(
        `UPDATE messages SET delivery_status = 'accepted' WHERE id = $1 AND delivery_status IN ('queued', 'unknown') RETURNING id`, [m.id]);
      if (r.rowCount) {
        queueEvent(c, 'message_status', { groupId: m.group_id, clientMsgId: m.client_msg_id, deliveryStatus: 'accepted' });
        await onSequenceMessageOutcome(c, m.client_msg_id, 'accepted');
      }
    });
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    await tx((c) => handleSendError(c, m, e));
  }
}

async function handleSendError(c: pg.PoolClient, m: any, e: GatewayError) {
  const release = () => c.query(`UPDATE messages SET attempt_started_at = NULL WHERE id = $1`, [m.id]);
  switch (e.code) {
    case 'RATE_LIMITED':
      await release(); // definitely not sent; stays queued in place
      await rateLimit(c, m.account_id, Number(e.body?.retryAfterSeconds ?? 1));
      return;
    case 'ACCOUNT_SUSPENDED':
    case 'SESSION_EXPIRED':
      await release(); // not sent; the terminal cascade cancels it with the rest of the queue
      await enterTerminal(c, m.account_id, e.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired');
      return;
    case 'GROUP_WRITE_FORBIDDEN':
      await fail(c, m, 'GROUP_WRITE_FORBIDDEN');
      await markGroupUnreachable(c, m.group_id);
      return;
    case 'SENDER_NOT_IN_GROUP':
    case 'ACCOUNT_OFFLINE':
      await fail(c, m, e.code);
      return;
    case 'NETWORK_TIMEOUT':
      unknownSinceMono.set(m.client_msg_id, performance.now());
      await c.query(`UPDATE messages SET delivery_status = 'unknown', unknown_since = now() WHERE id = $1 AND delivery_status = 'queued'`, [m.id]);
      queueEvent(c, 'message_status', { groupId: m.group_id, clientMsgId: m.client_msg_id, deliveryStatus: 'unknown' });
      return;
    default:
      if (e.status === 503 || e.status >= 500) {
        // Endpoint unavailable: the request was not taken. Retry with a small backoff.
        await c.query(`UPDATE messages SET attempt_started_at = NULL, next_attempt_at = now() + interval '1 second' WHERE id = $1`, [m.id]);
        return;
      }
      await fail(c, m, e.code);
  }
}

async function fail(c: pg.PoolClient, m: { id: number; group_id: string; client_msg_id: string }, code: string) {
  const r = await c.query(
    `UPDATE messages SET delivery_status = 'failed', fail_code = $2 WHERE id = $1 AND delivery_status IN ('queued', 'unknown', 'accepted') RETURNING id`, [m.id, code]);
  if (!r.rowCount) return;
  queueEvent(c, 'message_status', { groupId: m.group_id, clientMsgId: m.client_msg_id, deliveryStatus: 'failed' });
  await onSequenceMessageOutcome(c, m.client_msg_id, 'failed');
}

/**
 * Resolve `unknown` rows via by-client-id:
 *   200            → it landed: sent
 *   404 < 2s       → gateway may still be converging: wait
 *   404 ≥ 2s       → definitely not sent: resend once (same clientMsgId), else failed NETWORK_TIMEOUT
 *   503 / error    → stay unknown; this runs every 200ms so we decide within 2s of recovery
 */
async function resolveUnknown() {
  const { rows } = await pool.query(`
    SELECT m.id, m.group_id, m.client_msg_id, m.resend_count, g.gateway_group_id,
           extract(epoch from (now() - m.unknown_since)) * 1000 AS unknown_age_ms
      FROM messages m JOIN groups g ON g.id = m.group_id
     WHERE m.delivery_status = 'unknown'`);
  await Promise.all(rows.map(async (m) => {
    let landed: { msgId: string; sentAt: string } | null = null;
    try { landed = (await gateway.byClientId(m.gateway_group_id, m.client_msg_id)).data; }
    catch (e) {
      if (!(e instanceof GatewayError) || e.status !== 404) return; // unavailable: keep unknown
    }
    await tx(async (c) => {
      const cur = await c.query(`SELECT delivery_status FROM messages WHERE id = $1 FOR UPDATE`, [m.id]);
      if (cur.rows[0]?.delivery_status !== 'unknown') return; // resolved concurrently (e.g. message_sent arrived)
      if (landed) { unknownSinceMono.delete(m.client_msg_id); return markSent(c, m.client_msg_id, landed.msgId, landed.sentAt); }
      if (Number(m.unknown_age_ms) < UNKNOWN_SETTLE_MS) return;
      const mono = unknownSinceMono.get(m.client_msg_id);
      if (mono !== undefined && performance.now() - mono < UNKNOWN_SETTLE_MS) return;
      unknownSinceMono.delete(m.client_msg_id);
      if (m.resend_count < 1) {
        await c.query(
          `UPDATE messages SET delivery_status = 'queued', attempt_started_at = NULL, unknown_since = NULL, resend_count = resend_count + 1
            WHERE id = $1`, [m.id]);
        queueEvent(c, 'message_status', { groupId: m.group_id, clientMsgId: m.client_msg_id, deliveryStatus: 'queued' });
        nudge();
      } else {
        await fail(c, m, 'NETWORK_TIMEOUT');
      }
    });
  }));
}

/**
 * A client message is confirmed on the gateway (message_sent event or by-client-id 200).
 * If its echo (`message` event) arrived first it was stored as its own row; fold it in so
 * the timeline keeps exactly one row per message.
 */
export async function markSent(c: pg.PoolClient, clientMsgId: string, msgId: string, sentAt: string) {
  const { rows } = await c.query(`SELECT id, group_id, msg_id, delivery_status FROM messages WHERE client_msg_id = $1 FOR UPDATE`, [clientMsgId]);
  const row = rows[0];
  if (!row) return false;
  if (row.delivery_status === 'sent') return true; // duplicate confirmation; keep the first msgId
  const echo = await c.query(`DELETE FROM messages WHERE group_id = $1 AND msg_id = $2 AND id <> $3 RETURNING media_url`, [row.group_id, msgId, row.id]);
  await c.query(
    `UPDATE messages SET msg_id = $2, sent_at = $3, delivery_status = 'sent', fail_code = NULL, unknown_since = NULL,
            media_url = coalesce(media_url, $4) WHERE id = $1`, [row.id, msgId, sentAt, echo.rows[0]?.media_url ?? null]);
  queueEvent(c, 'message_status', { groupId: row.group_id, clientMsgId, deliveryStatus: 'sent' });
  await onSequenceMessageOutcome(c, clientMsgId, 'sent');
  return true;
}

export async function markFailedByGateway(c: pg.PoolClient, clientMsgId: string, code: string) {
  const { rows } = await c.query(`SELECT id, group_id, client_msg_id, account_id FROM messages WHERE client_msg_id = $1 FOR UPDATE`, [clientMsgId]);
  if (!rows[0]) return;
  await fail(c, rows[0], code);
  if (code === 'GROUP_WRITE_FORBIDDEN') await markGroupUnreachable(c, rows[0].group_id);
  if (code === 'ACCOUNT_SUSPENDED') await enterTerminal(c, rows[0].account_id, 'suspended');
}
