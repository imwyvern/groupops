/**
 * Mock message gateway implementing the contract in spec §2.1.
 *
 * Normal behaviour follows the spec's happy path with realistic latencies.
 * Failure modes are driven through the `/__control` and `/__inject/*` endpoints
 * so that scenario tests (S1–S8) and live demos can reproduce them on demand.
 */
import type http from 'node:http';
import { createRouter, send, sleep, rand } from './http.js';

type Terminal = 'suspended' | 'session_expired';
interface Account { platformUserId: string; online: boolean; terminal: Terminal | null; rateLimitedUntil: number; retryAfter: number }
interface Group { owner: string; members: Set<string>; promoted: Set<string>; ownerLeft: boolean; writable: boolean; invites: Map<string, { readyAt: number; expired: boolean }> }
interface Msg { groupId: string; msgId: string; clientMsgId: string | null; sender: string; text: string; sentAt: string }
interface Evt { eventId: number; type: string; data: Record<string, unknown> }

/** Knobs. `sendScript` is a FIFO consumed one entry per `send` call (then falls back to 'ok'). */
const defaults = () => ({
  duplicateEvents: false,        // S2: every event is pushed twice
  reorder: false,                // swap adjacent events (stays inside the 1s window)
  sentDelayMs: [50, 400] as [number, number],
  joinDelayMs: [100, 600] as [number, number],
  acceptDelayMs: 0,              // how long `send` takes before answering 202
  sendScript: [] as string[],    // 'ok' | '504-land' | '504-lost' | '429:N' | '503' | 'fail-forbidden' | 'forbidden' | 'not-in-group'
  inviteReadyMs: 0,
  expireNextInvite: false,
  dropJoinFor: [] as string[],   // accountIds whose member_joined never arrives
  kickScript: [] as string[],    // 'ok' | '504' | 'slow'
  leaveFailFor: [] as string[],  // accountIds whose leave returns 500
  byClientIdUnavailable: false,  // by-client-id answers 503
});
let knobs = defaults();

const accounts = new Map<string, Account>();
const groups = new Map<string, Group>();
const messages: Msg[] = [];
const events: Evt[] = [];
const clients = new Set<http.ServerResponse>();
let nextEventId = 1, nextGroup = 1, nextMsg = 1;
/** Observability for tests: sends received while an account was rate limited (must stay 0). */
const stats = { sendCalls: 0, sendsWhileLimited: 0, promoteCalls: 0 };

const puidOf = (accountId: string) => `pu_${accountId}`;
const accountByPuid = (puid: string) => [...accounts.entries()].find(([, a]) => a.platformUserId === puid)?.[0];
const acct = (id: string) => {
  let a = accounts.get(id);
  if (!a) accounts.set(id, (a = { platformUserId: puidOf(id), online: false, terminal: null, rateLimitedUntil: 0, retryAfter: 0 }));
  return a;
};

function emit(type: string, data: Record<string, unknown>) {
  const evt: Evt = { eventId: nextEventId++, type, data: { ...data, eventId: 0, type } };
  evt.data.eventId = evt.eventId;
  events.push(evt);
  const frames = knobs.duplicateEvents ? [evt, evt] : [evt];
  if (knobs.reorder) setTimeout(() => frames.forEach(write), rand(0, 800));
  else frames.forEach(write);
}
function write(e: Evt) {
  const frame = `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
  for (const c of clients) c.write(frame);
}

/** Account-level guard shared by every account-scoped endpoint. Returns true if it already replied. */
function guard(res: http.ServerResponse, accountId: string, needOnline = true): boolean {
  const a = acct(accountId);
  if (a.terminal === 'suspended') return send(res, 403, { code: 'ACCOUNT_SUSPENDED', message: 'account suspended' }), true;
  if (a.terminal === 'session_expired') return send(res, 401, { code: 'SESSION_EXPIRED', message: 'session expired' }), true;
  if (needOnline && !a.online) return send(res, 409, { code: 'ACCOUNT_OFFLINE', message: 'account offline' }), true;
  return false;
}

function makeTerminal(accountId: string, status: Terminal, pushEvent = true) {
  const a = acct(accountId);
  a.terminal = status; a.online = false;
  if (pushEvent) emit('account_status', { accountId, status });
  for (const [gid, g] of groups) if (g.members.delete(a.platformUserId)) emit('member_left', { groupId: gid, platformUserId: a.platformUserId });
}

function land(groupId: string, sender: string, text: string, clientMsgId: string | null, extra: Record<string, unknown> = {}) {
  const m: Msg = { groupId, msgId: `m_${nextMsg++}`, clientMsgId, sender, text, sentAt: new Date().toISOString() };
  messages.push(m);
  if (clientMsgId) emit('message_sent', { clientMsgId, msgId: m.msgId, sentAt: m.sentAt });
  emit('message', { groupId, msgId: m.msgId, senderPlatformUserId: sender, text, sentAt: m.sentAt, ...extra });
  return m;
}

const r = createRouter();

// ---------- accounts ----------
r.post('/accounts/:id/connect', (req, res) => {
  if (guard(res, req.params.id, false)) return;
  const a = acct(req.params.id);
  a.online = true;
  send(res, 200, { platformUserId: a.platformUserId });
});
r.post('/accounts/:id/disconnect', (req, res) => {
  if (guard(res, req.params.id, false)) return;
  acct(req.params.id).online = false;
  send(res, 200, {});
});

// ---------- groups ----------
r.post('/groups', (req, res) => {
  const creator = req.body.creatorAccountId;
  if (guard(res, creator)) return;
  const groupId = `g_${nextGroup++}`;
  groups.set(groupId, { owner: acct(creator).platformUserId, members: new Set([acct(creator).platformUserId]), promoted: new Set(), ownerLeft: false, writable: true, invites: new Map() });
  send(res, 200, { groupId });
});
const grp = (res: http.ServerResponse, id: string) => {
  const g = groups.get(id);
  if (!g) send(res, 404, { code: 'GROUP_NOT_FOUND', message: id });
  return g;
};
r.post('/groups/:gid/invite', (req, res) => {
  const g = grp(res, req.params.gid); if (!g) return;
  const inviteLink = `https://gw.invalid/i/${Math.random().toString(36).slice(2)}`;
  g.invites.set(inviteLink, { readyAt: Date.now() + knobs.inviteReadyMs, expired: knobs.expireNextInvite });
  knobs.expireNextInvite = false;
  send(res, 200, { inviteLink, readyAfterMs: knobs.inviteReadyMs });
});
r.post('/groups/:gid/join', (req, res) => {
  const g = grp(res, req.params.gid); if (!g) return;
  const { accountId, inviteLink } = req.body;
  if (guard(res, accountId)) return;
  const inv = g.invites.get(inviteLink);
  if (!inv || inv.expired) return send(res, 410, { code: 'INVITE_EXPIRED', message: 'invite expired' });
  if (Date.now() < inv.readyAt) return send(res, 409, { code: 'INVITE_NOT_READY', message: 'invite not ready' });
  const puid = acct(accountId).platformUserId;
  if (g.members.has(puid)) return send(res, 409, { code: 'ALREADY_MEMBER', message: 'already member' });
  send(res, 202, { accepted: true });
  if (knobs.dropJoinFor.includes(accountId)) return;
  setTimeout(() => { g.members.add(puid); emit('member_joined', { groupId: req.params.gid, platformUserId: puid }); }, rand(...knobs.joinDelayMs));
});
r.post('/groups/:gid/promote', (req, res) => {
  const g = grp(res, req.params.gid); if (!g) return;
  stats.promoteCalls++;
  const { byAccountId, accountId } = req.body;
  if (guard(res, byAccountId)) return;
  if (acct(byAccountId).platformUserId !== g.owner) return send(res, 403, { code: 'NO_PERMISSION', message: 'not owner' });
  const puid = acct(accountId).platformUserId;
  if (!g.members.has(puid)) return send(res, 409, { code: 'NOT_MEMBER_YET', message: 'not a member yet' });
  g.promoted.add(puid);
  send(res, 200, {});
});
r.post('/groups/:gid/kick', async (req, res) => {
  const g = grp(res, req.params.gid); if (!g) return;
  const { byAccountId, targetPlatformUserId } = req.body;
  if (guard(res, byAccountId)) return;
  if (g.ownerLeft) return send(res, 409, { code: 'OWNER_LEFT', message: 'owner left' });
  const by = acct(byAccountId).platformUserId;
  if (by !== g.owner && !g.promoted.has(by)) return send(res, 403, { code: 'NO_PERMISSION', message: 'no permission' });
  const mode = knobs.kickScript.shift() ?? 'ok';
  const removed = g.members.delete(targetPlatformUserId);
  if (removed) setTimeout(() => emit('member_left', { groupId: req.params.gid, platformUserId: targetPlatformUserId }), 50);
  if (mode === '504') { await sleep(1000); return send(res, 504, { code: 'NETWORK_TIMEOUT', message: 'timeout' }); }
  await sleep(mode === 'slow' ? 4000 : rand(200, 800));
  send(res, 200, { kicked: true });
});
r.post('/groups/:gid/leave', (req, res) => {
  const g = grp(res, req.params.gid); if (!g) return;
  const { accountId } = req.body;
  if (guard(res, accountId, false)) return;
  if (knobs.leaveFailFor.includes(accountId)) return send(res, 500, { code: 'INTERNAL', message: 'leave failed' });
  const puid = acct(accountId).platformUserId;
  g.members.delete(puid);
  if (puid === g.owner) g.ownerLeft = true;
  send(res, 200, {});
  setTimeout(() => emit('member_left', { groupId: req.params.gid, platformUserId: puid }), 50);
});
r.get('/groups/:gid/members', (req, res) => {
  const g = grp(res, req.params.gid); if (!g) return;
  send(res, 200, [...g.members].map((platformUserId) => ({ platformUserId })));
});

// ---------- messages ----------
r.post('/groups/:gid/send', async (req, res) => {
  const g = grp(res, req.params.gid); if (!g) return;
  const { accountId, clientMsgId, text } = req.body;
  stats.sendCalls++;
  if (guard(res, accountId)) return;
  const a = acct(accountId);
  if (Date.now() < a.rateLimitedUntil) {
    stats.sendsWhileLimited++;
    a.rateLimitedUntil = Date.now() + a.retryAfter * 1000; // any send during the window resets it
    return send(res, 429, { code: 'RATE_LIMITED', message: 'rate limited', retryAfterSeconds: a.retryAfter });
  }
  const mode = knobs.sendScript.shift() ?? 'ok';
  if (mode.startsWith('429:')) {
    a.retryAfter = Number(mode.slice(4));
    a.rateLimitedUntil = Date.now() + a.retryAfter * 1000;
    return send(res, 429, { code: 'RATE_LIMITED', message: 'rate limited', retryAfterSeconds: a.retryAfter });
  }
  if (mode === 'suspended') { makeTerminal(accountId, 'suspended', false); return send(res, 403, { code: 'ACCOUNT_SUSPENDED', message: 'suspended' }); }
  if (mode === 'session_expired') { makeTerminal(accountId, 'session_expired', false); return send(res, 401, { code: 'SESSION_EXPIRED', message: 'expired' }); }
  if (mode === '503') return send(res, 503, { code: 'UNAVAILABLE', message: 'unavailable' });
  if (mode === 'forbidden' || !g.writable) { g.writable = false; return send(res, 403, { code: 'GROUP_WRITE_FORBIDDEN', message: 'group not writable' }); }
  if (mode === 'not-in-group' || !g.members.has(a.platformUserId)) return send(res, 403, { code: 'SENDER_NOT_IN_GROUP', message: 'sender not in group' });
  if (mode === '504-land') {
    setTimeout(() => land(req.params.gid, a.platformUserId, text, clientMsgId), 1500);
    return send(res, 504, { code: 'NETWORK_TIMEOUT', message: 'timeout' });
  }
  if (mode === '504-lost') return send(res, 504, { code: 'NETWORK_TIMEOUT', message: 'timeout' });
  if (knobs.acceptDelayMs) await sleep(knobs.acceptDelayMs);
  send(res, 202, { accepted: true });
  setTimeout(() => {
    if (mode === 'fail-forbidden') { g.writable = false; emit('message_failed', { clientMsgId, code: 'GROUP_WRITE_FORBIDDEN' }); return; }
    land(req.params.gid, a.platformUserId, text, clientMsgId);
  }, rand(...knobs.sentDelayMs));
});
r.get('/groups/:gid/messages/by-client-id/:cid', (req, res) => {
  if (knobs.byClientIdUnavailable) return send(res, 503, { code: 'UNAVAILABLE', message: 'unavailable' });
  const m = messages.find((x) => x.groupId === req.params.gid && x.clientMsgId === req.params.cid);
  if (!m) return send(res, 404, { code: 'NOT_FOUND', message: 'not landed' });
  send(res, 200, { msgId: m.msgId, sentAt: m.sentAt });
});

// ---------- event stream ----------
r.get('/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const since = req.query.get('since');
  if (since !== null) for (const e of events) if (e.eventId > Number(since)) write1(res, e);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
function write1(res: http.ServerResponse, e: Evt) { res.write(`id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`); }

// ---------- test / demo controls ----------
r.post('/__control', (req, res) => { knobs = { ...knobs, ...req.body }; send(res, 200, knobs); });
r.post('/__reset', (_req, res) => { knobs = defaults(); Object.assign(stats, { sendCalls: 0, sendsWhileLimited: 0, promoteCalls: 0 }); send(res, 200, {}); });
r.get('/__state', (_req, res) => send(res, 200, {
  stats, lastEventId: nextEventId - 1,
  accounts: Object.fromEntries(accounts),
  groups: Object.fromEntries([...groups].map(([k, g]) => [k, { ...g, members: [...g.members], promoted: [...g.promoted], invites: undefined }])),
  messages,
}));
/** An external (non service-account) user posts into a group. */
r.post('/__inject/message', (req, res) => {
  const { groupId, senderPlatformUserId = 'ext_alice', text = 'hello', mediaUrl } = req.body;
  const g = grp(res, groupId); if (!g) return;
  if (!g.members.has(senderPlatformUserId)) { g.members.add(senderPlatformUserId); emit('member_joined', { groupId, platformUserId: senderPlatformUserId }); }
  send(res, 200, land(groupId, senderPlatformUserId, text, null, mediaUrl ? { mediaUrl } : {}));
});
r.post('/__inject/account-status', (req, res) => { makeTerminal(req.body.accountId, req.body.status); send(res, 200, {}); });
r.post('/__inject/group-forbidden', (req, res) => { const g = grp(res, req.body.groupId); if (!g) return; g.writable = false; send(res, 200, {}); });
/** Drop every live SSE connection (forces the backend to reconnect with `since`). */
r.post('/__inject/drop-stream', (_req, res) => { for (const c of clients) c.destroy(); clients.clear(); send(res, 200, {}); });

const port = Number(process.env.PORT ?? 4001);
r.server.listen(port, () => console.log(`[mock-gateway] listening on :${port}`));
