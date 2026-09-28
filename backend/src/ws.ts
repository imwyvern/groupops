import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import pg from 'pg';
import { pool } from './db.js';
import { config } from './config.js';
import { verifyAccessToken } from './auth.js';

interface Client { ws: WebSocket; lastSeq: number; ready: boolean }
const clients = new Set<Client>();
let head = 0; // highest seq fanned out by this instance

const joining: Client[] = [];

/**
 * Pull committed events after `head` and fan them out. Triggered by LISTEN/NOTIFY (works across instances).
 * All sends happen inside this serialized function — including the sinceSeq replay for newly
 * authenticated clients — so a client can never receive a live frame before its replay finishes.
 */
async function pump() {
  while (joining.length) {
    const c = joining.shift()!;
    if (c.ws.readyState !== c.ws.OPEN) continue;
    const { rows } = await pool.query('SELECT seq, type, payload FROM ws_events WHERE seq > $1 AND seq <= $2 ORDER BY seq', [c.lastSeq, head]);
    for (const r of rows) { c.ws.send(JSON.stringify({ seq: r.seq, type: r.type, payload: r.payload })); c.lastSeq = r.seq; }
    c.lastSeq = Math.max(c.lastSeq, head);
    c.ready = true;
    clients.add(c);
  }
  const { rows } = await pool.query('SELECT seq, type, payload FROM ws_events WHERE seq > $1 ORDER BY seq LIMIT 1000', [head]);
  for (const r of rows) {
    head = r.seq;
    const frame = JSON.stringify({ seq: r.seq, type: r.type, payload: r.payload });
    for (const c of clients) if (c.ready && r.seq > c.lastSeq) { c.ws.send(frame); c.lastSeq = r.seq; }
  }
  if (rows.length === 1000) return pump();
}
let pumping: Promise<void> | null = null, again = false;
function schedulePump() {
  if (pumping) { again = true; return; }
  pumping = pump().catch((e) => console.error('[ws] pump', e)).finally(() => { pumping = null; if (again) { again = false; schedulePump(); } });
}

export async function startWs(server: Server) {
  head = (await pool.query('SELECT coalesce(max(seq), 0) AS s FROM ws_events')).rows[0].s;
  const listener = new pg.Client({ connectionString: config.databaseUrl });
  await listener.connect();
  await listener.query('LISTEN ws_events');
  listener.on('notification', schedulePump);
  setInterval(schedulePump, 2000).unref(); // safety net if a NOTIFY is missed

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const client: Client = { ws, lastSeq: 0, ready: false };
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);
    ws.on('message', async (raw) => {
      if (client.ready) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return ws.close(4000, 'bad frame'); }
      if (msg?.type !== 'auth') return;
      const user = await verifyAccessToken(msg.accessToken).catch(() => null);
      if (!user) { ws.send(JSON.stringify({ type: 'auth', success: false })); return ws.close(4001, 'unauthorized'); }
      clearTimeout(authTimer);
      ws.send(JSON.stringify({ type: 'auth', success: true }));
      // B4: with sinceSeq the pump replays everything after it, then continues live.
      client.lastSeq = typeof msg.sinceSeq === 'number' ? msg.sinceSeq : head;
      joining.push(client);
      schedulePump();
    });
    ws.on('close', () => { clearTimeout(authTimer); clients.delete(client); });
  });
}
