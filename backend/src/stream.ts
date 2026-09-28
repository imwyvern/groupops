/**
 * Gateway event stream consumer (spec A2 + §2.1 "事件流").
 *
 *  - Dedup: each event is handled in one transaction together with an insert into
 *    `processed_events`; a duplicate delivery hits the primary key and is skipped.
 *    Messages are additionally unique on (group_id, msg_id), which also covers
 *    offline back-fills that arrive with a new eventId.
 *  - Resume cursor: events may arrive out of order within 1s, so "highest eventId seen"
 *    is not safe to resume from. We persist the highest id seen at least 1.5s ago;
 *    everything at or below it has certainly been received. Reconnects replay from
 *    there and dedup absorbs the overlap.
 *  - DB failure while handling: the event is appended to a local journal (never lost),
 *    an `inconsistency` event is raised, the stream keeps flowing, and the journal is
 *    retried until it drains.
 */
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { pool, tx, queueEvent } from './db.js';
import { config } from './config.js';
import { enterTerminal } from './domain.js';
import { markSent, markFailedByGateway } from './outbox.js';
import { onInboundMessage } from './agent/trigger.js';

interface GwEvent { eventId: number; type: string; [k: string]: any }

const JOURNAL = path.resolve(process.env.DATA_DIR ?? 'data', 'failed-events.jsonl');
const SAFE_LAG_MS = 1_500;
const seen: { id: number; at: number }[] = [];
let safeCursor = 0;
let stopped = false;

export async function startStream() {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  safeCursor = (await pool.query('SELECT safe_event_id FROM gateway_cursor WHERE id = 1')).rows[0].safe_event_id;
  setInterval(persistCursor, 1_000).unref();
  setInterval(retryJournal, 2_000).unref();
  void connectLoop();
}
export function stopStream() { stopped = true; }

async function connectLoop() {
  let backoff = 250;
  while (!stopped) {
    try {
      await consume(`${config.gatewayUrl}/events?since=${safeCursor}`);
      backoff = 250;
    } catch (e: any) {
      if (!stopped) console.warn(`[stream] disconnected: ${e?.message ?? e}; retry in ${backoff}ms`);
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 5_000);
  }
}

async function consume(url: string) {
  const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let evt: GwEvent;
      try { evt = JSON.parse(data); } catch { console.warn('[stream] unparseable frame', frame); continue; }
      await handleSafely(evt);
    }
  }
  throw new Error('stream ended');
}

async function handleSafely(evt: GwEvent) {
  try {
    await handleEvent(evt);
  } catch (e: any) {
    fs.appendFileSync(JOURNAL, JSON.stringify(evt) + '\n');
    console.error(`[stream] event ${evt.eventId} (${evt.type}) journaled: ${e?.message ?? e}`);
    await raiseInconsistency('event_handling_failed', String(evt.eventId), `${evt.type}: ${e?.message ?? e}`);
  }
  // Only now is the event durable (committed or journaled), so only now may the resume cursor pass it.
  seen.push({ id: evt.eventId, at: Date.now() });
}

/** Inconsistencies that could not be persisted (DB down) are retried until they reach the operator. */
const unsentInconsistencies: { kind: string; ref: string; message: string }[] = [];
async function raiseInconsistency(kind: string, ref: string, message: string) {
  unsentInconsistencies.push({ kind, ref, message });
  await flushInconsistencies();
}
async function flushInconsistencies() {
  while (unsentInconsistencies.length) {
    const i = unsentInconsistencies[0];
    try { await tx(async (c) => queueEvent(c, 'inconsistency', i)); unsentInconsistencies.shift(); }
    catch { console.error(`[inconsistency] ${i.kind} ${i.ref} ${i.message} (queued until the database is back)`); return; }
  }
}

/** Handle one event exactly once. Exported for tests. */
export async function handleEvent(evt: GwEvent) {
  await tx(async (c) => {
    const fresh = await c.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [evt.eventId]);
    if (!fresh.rowCount) return; // duplicate delivery
    switch (evt.type) {
      case 'message': return onMessage(c, evt);
      case 'message_sent': return void (await markSent(c, evt.clientMsgId, evt.msgId, evt.sentAt));
      case 'message_failed': return markFailedByGateway(c, evt.clientMsgId, evt.code);
      case 'member_joined': return onMemberJoined(c, evt);
      case 'member_left': return onMemberLeft(c, evt);
      case 'account_status':
        if (evt.status === 'suspended' || evt.status === 'session_expired') await enterTerminal(c, evt.accountId, evt.status);
        return;
    }
  });
}

async function onMessage(c: pg.PoolClient, e: GwEvent) {
  const g = (await c.query('SELECT id, status, agent_enabled FROM groups WHERE gateway_group_id = $1', [e.groupId])).rows[0];
  if (!g) return; // not a group we manage
  const own = await c.query('SELECT id FROM accounts WHERE platform_user_id = $1', [e.senderPlatformUserId]);
  const isOwn = own.rowCount! > 0;
  if (isOwn) {
    // Our own message echoed back. If message_sent already folded it into the outbox row, this is a no-op.
    const exists = await c.query('SELECT 1 FROM messages WHERE group_id = $1 AND msg_id = $2', [g.id, e.msgId]);
    if (exists.rowCount) return;
    // The echo can beat message_sent. Attach it to our in-flight row now so the timeline keeps one
    // row per message. An account can have several accepted-but-unconfirmed messages, so match on
    // text too; if that is still ambiguous, fall back to a separate row that message_sent will fold in.
    const inflight = await c.query(
      `SELECT id, client_msg_id FROM messages WHERE group_id = $1 AND account_id = $2 AND msg_id IS NULL AND text = $3
          AND attempt_started_at IS NOT NULL AND delivery_status IN ('queued', 'accepted', 'unknown') LIMIT 2`, [g.id, own.rows[0].id, e.text ?? '']);
    if (inflight.rowCount === 1) {
      await c.query('UPDATE messages SET msg_id = $2, sent_at = $3 WHERE id = $1', [inflight.rows[0].id, e.msgId, e.sentAt]);
      queueEvent(c, 'message', { groupId: g.id, msgId: e.msgId, isOwn: true });
      return;
    }
  }
  const ins = await c.query(
    `INSERT INTO messages (group_id, msg_id, sender_platform_user_id, account_id, is_own, text, sent_at, delivery_status, media_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (group_id, msg_id) WHERE msg_id IS NOT NULL DO NOTHING RETURNING id`,
    [g.id, e.msgId, e.senderPlatformUserId, own.rows[0]?.id ?? null, isOwn, e.text ?? '', e.sentAt, isOwn ? 'sent' : null, e.mediaUrl ?? null]);
  if (!ins.rowCount) return; // replayed message (new eventId, same msgId)
  queueEvent(c, 'message', { groupId: g.id, msgId: e.msgId, isOwn });
  if (!isOwn && g.agent_enabled && g.status === 'active') {
    await onInboundMessage(c, g.id, { msgId: e.msgId, senderPlatformUserId: e.senderPlatformUserId, text: e.text ?? '', sentAt: e.sentAt });
  }
}

async function onMemberJoined(c: pg.PoolClient, e: GwEvent) {
  const g = (await c.query('SELECT id, status FROM groups WHERE gateway_group_id = $1', [e.groupId])).rows[0];
  const a = (await c.query('SELECT id, status FROM accounts WHERE platform_user_id = $1', [e.platformUserId])).rows[0];
  if (!g || !a || g.status === 'left' || a.status === 'suspended' || a.status === 'session_expired') return;
  const r = await c.query(
    `INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`,
    [g.id, a.id, e.platformUserId]);
  if (r.rowCount) queueEvent(c, 'member_changed', { groupId: g.id });
}

async function onMemberLeft(c: pg.PoolClient, e: GwEvent) {
  const g = (await c.query('SELECT id FROM groups WHERE gateway_group_id = $1', [e.groupId])).rows[0];
  if (!g) return;
  const r = await c.query('DELETE FROM group_members WHERE group_id = $1 AND platform_user_id = $2', [g.id, e.platformUserId]);
  if (r.rowCount) queueEvent(c, 'member_changed', { groupId: g.id });
}

async function persistCursor() {
  const cutoff = Date.now() - SAFE_LAG_MS;
  let candidate = safeCursor;
  while (seen.length && seen[0].at <= cutoff) candidate = Math.max(candidate, seen.shift()!.id);
  if (candidate === safeCursor) return;
  try {
    await pool.query('UPDATE gateway_cursor SET safe_event_id = $1 WHERE id = 1 AND safe_event_id < $1', [candidate]);
    await pool.query('DELETE FROM processed_events WHERE event_id <= $1', [candidate - 10_000]);
    safeCursor = candidate;
  } catch { /* DB down: keep the old cursor; replay + dedup covers it */ }
}

let retrying = false;
async function retryJournal() {
  await flushInconsistencies();
  if (retrying || !fs.existsSync(JOURNAL)) return;
  retrying = true;
  try {
    const lines = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean);
    if (!lines.length) return;
    const remaining: string[] = [];
    for (const line of lines) {
      try { await handleEvent(JSON.parse(line)); } catch { remaining.push(line); }
    }
    fs.writeFileSync(JOURNAL, remaining.map((l) => l + '\n').join(''));
    if (remaining.length < lines.length) console.log(`[stream] journal replayed ${lines.length - remaining.length} event(s)`);
  } finally { retrying = false; }
}
