/**
 * Spec §2.4 scenarios S1–S8, plus the restart / concurrency invariants from A0–A5.
 * Run with `pnpm test` (needs the docker-compose Postgres).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, login, api, gw, agent, makeGroup, waitFor, sleep, killBackend, startBackend, dbQuery, http, B } from './harness.js';

let token: string;
let a: ReturnType<typeof api>;

before(async () => { await setup(); token = await login(); a = api(token); });
after(teardown);
beforeEach(async () => { await gw.reset(); await agent.reset(); });

const messages = async (groupId: string) => (await a.get(`/api/groups/${groupId}/messages?limit=200`)).body.items as any[];
const byClient = async (groupId: string, clientMsgId: string) => (await messages(groupId)).find((m) => m.clientMsgId === clientMsgId);
const runsOf = async (groupId: string) => (await a.get(`/api/groups/${groupId}/agent-runs`)).body as any[];
const runDetail = async (id: string) => (await a.get(`/api/agent-runs/${id}`)).body;
const settledRun = (groupId: string, n = 1) => waitFor(async () => {
  const runs = await runsOf(groupId);
  return runs.length >= n && runs.every((r) => r.status !== 'running') && runs;
}, 30_000, 'agent run to settle');

// ------------------------------------------------------------------ A0

test('A0: viewer is read-only (403 FORBIDDEN on writes), errors carry requestId', async () => {
  const v = api(await login('viewer'));
  assert.equal((await v.get('/api/accounts')).status, 200);
  const r = await v.post('/api/accounts/acc_01/connect');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'FORBIDDEN');
  assert.ok(r.body.error.requestId);
  assert.equal((await http('GET', `${B}/api/accounts`)).body.error.code, 'UNAUTHORIZED');
});

// ------------------------------------------------------------------ A1

test('A1: transition table and CAS — concurrent changes, exactly one wins', async () => {
  const { accounts: [id] } = await makeGroup(token);
  assert.equal((await a.post(`/api/accounts/${id}/transition`, { to: 'online', expectedFrom: 'online' })).body.error.code, 'ILLEGAL_TRANSITION');
  assert.equal((await a.post(`/api/accounts/${id}/transition`, { to: 'rate_limited', expectedFrom: 'idle' })).body.error.code, 'ILLEGAL_TRANSITION');
  assert.equal((await a.post(`/api/accounts/nope/transition`, { to: 'idle', expectedFrom: 'online' })).status, 404);
  assert.equal((await a.post(`/api/accounts/${id}/transition`, { to: 'idle' })).status, 400);

  const [r1, r2] = await Promise.all([
    a.post(`/api/accounts/${id}/transition`, { to: 'disconnected', expectedFrom: 'online' }),
    a.post(`/api/accounts/${id}/transition`, { to: 'idle', expectedFrom: 'online' }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal([r1, r2].find((r) => r.status === 409)!.body.error.code, 'CAS_CONFLICT');
});

test('A1: terminal state from a gateway event removes the account from groups and cancels its queue', async () => {
  const { group, admin } = await makeGroup(token);
  await gw.control({ sendScriptFor: { [group.gatewayGroupId]: ['429:30'] } }); // park the account so its next sends stay queued
  const first = (await a.post(`/api/groups/${group.id}/send`, { accountId: admin, text: 'held 1' })).body.clientMsgId;
  await waitFor(async () => (await a.get('/api/accounts')).body.find((x: any) => x.id === admin).status === 'rate_limited', 5_000, 'rate_limited');
  const queued = (await a.post(`/api/groups/${group.id}/send`, { accountId: admin, text: 'held 2' })).body.clientMsgId;

  await gw.accountStatus(admin, 'suspended');
  await waitFor(async () => (await a.get('/api/accounts')).body.find((x: any) => x.id === admin).status === 'suspended', 5_000, 'suspended');
  const g = (await a.get(`/api/groups/${group.id}`)).body;
  assert.ok(!g.members.some((m: any) => m.accountId === admin));
  for (const cid of [first, queued]) {
    const m = await byClient(group.id, cid);
    assert.equal(m.deliveryStatus, 'cancelled');
    assert.equal(m.failCode, 'ACCOUNT_TERMINAL');
  }
  // terminal has no out-edges, reconnect included
  assert.equal((await a.post(`/api/accounts/${admin}/connect`)).status, 409);
});

// ------------------------------------------------------------------ S1–S4 (A2)

test('S1: accepted until message_sent, then sent', async () => {
  const { group, member } = await makeGroup(token);
  await gw.control({ sentDelayMs: [1500, 1500] });
  const { clientMsgId } = (await a.post(`/api/groups/${group.id}/send`, { accountId: member, text: 's1' })).body;
  assert.equal((await waitFor(async () => { const m = await byClient(group.id, clientMsgId); return m?.deliveryStatus === 'accepted' && m; }, 3_000, 'accepted')).deliveryStatus, 'accepted');
  const sent = await waitFor(async () => { const m = await byClient(group.id, clientMsgId); return m?.deliveryStatus === 'sent' && m; }, 5_000, 'sent');
  assert.ok(sent.msgId);
  assert.equal((await messages(group.id)).filter((m) => m.text === 's1').length, 1, 'own message has exactly one row');
});

test('S2: every event pushed twice → no duplicate rows, exactly one agent run', async () => {
  const { group } = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'normal' });
  await gw.control({ duplicateEvents: true });
  await gw.inject(group.gatewayGroupId, 'dup please');
  const runs = await settledRun(group.id);
  await sleep(1000);
  assert.equal((await messages(group.id)).filter((m) => m.text === 'dup please').length, 1);
  assert.equal((await runsOf(group.id)).length, 1);
  assert.equal(runs[0].endReason, 'final');
});

test('S3: own message echo is isOwn and does not trigger the agent', async () => {
  const { group, member } = await makeGroup(token, { agentEnabled: true });
  const { clientMsgId } = (await a.post(`/api/groups/${group.id}/send`, { accountId: member, text: 'from us' })).body;
  const m = await waitFor(async () => { const x = await byClient(group.id, clientMsgId); return x?.deliveryStatus === 'sent' && x; }, 5_000, 'sent');
  assert.equal(m.isOwn, true);
  await sleep(800);
  assert.equal((await runsOf(group.id)).length, 0);
});

test('S4: RATE_LIMITED → rate_limited, gateway gets no sends until expiry, queue drains in order', async () => {
  const { group, member } = await makeGroup(token);
  await gw.control({ sendScriptFor: { [group.gatewayGroupId]: ['429:2'] } });
  const ids: string[] = [];
  for (const t of ['r1', 'r2', 'r3']) ids.push((await a.post(`/api/groups/${group.id}/send`, { accountId: member, text: t })).body.clientMsgId);
  const acc = await waitFor(async () => (await a.get('/api/accounts')).body.find((x: any) => x.id === member && x.status === 'rate_limited'), 3_000, 'rate_limited');
  assert.ok(acc.rateLimitedUntil);
  assert.ok((await Promise.all(ids.map((c) => byClient(group.id, c)))).every((m) => m.deliveryStatus === 'queued'));
  await waitFor(async () => (await Promise.all(ids.map((c) => byClient(group.id, c)))).every((m) => m.deliveryStatus === 'sent'), 10_000, 'all sent');
  assert.equal((await gw.state()).stats.sendsWhileLimited, 0);
  assert.equal((await a.get('/api/accounts')).body.find((x: any) => x.id === member).status, 'online');
  // We control submission order; landing order is up to the gateway's per-message latency.
  const order = (await gw.state()).stats.accepted.filter((m: any) => m.groupId === group.gatewayGroupId).map((m: any) => m.text);
  assert.deepEqual(order, ['r1', 'r2', 'r3']);
});

test('A2: 504 with a lost message → unknown → one resend → still lost → failed NETWORK_TIMEOUT', async () => {
  const { group, member } = await makeGroup(token);
  await gw.control({ sendScriptFor: { [group.gatewayGroupId]: ['504-lost', '504-lost'] } });
  const { clientMsgId } = (await a.post(`/api/groups/${group.id}/send`, { accountId: member, text: 'lost' })).body;
  await waitFor(async () => (await byClient(group.id, clientMsgId))?.deliveryStatus === 'unknown', 3_000, 'unknown');
  const m = await waitFor(async () => { const x = await byClient(group.id, clientMsgId); return x?.deliveryStatus === 'failed' && x; }, 10_000, 'failed');
  assert.equal(m.failCode, 'NETWORK_TIMEOUT');
  assert.equal((await gw.state()).stats.sendsByClientId[clientMsgId], 2, 'exactly one resend');
});

test('A2: 504 but the message landed → sent within 5s, never resent', async () => {
  const { group, member } = await makeGroup(token);
  await gw.control({ sendScriptFor: { [group.gatewayGroupId]: ['504-land'] } });
  const t0 = Date.now();
  const { clientMsgId } = (await a.post(`/api/groups/${group.id}/send`, { accountId: member, text: 'landed' })).body;
  await waitFor(async () => (await byClient(group.id, clientMsgId))?.deliveryStatus === 'sent', 6_000, 'sent');
  assert.ok(Date.now() - t0 < 6_000);
  assert.equal((await gw.state()).messages.filter((m: any) => m.clientMsgId === clientMsgId).length, 1);
});

// ------------------------------------------------------------------ S5, S6 (A5)

test('S5: agent reuses an idempotency_key after a 504 → one gateway message, one audit, run finishes', async () => {
  const { group } = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'retry-key' });
  await gw.control({ sendScriptFor: { [group.gatewayGroupId]: ['504-land'] } });
  await gw.inject(group.gatewayGroupId, 'please answer');
  const [run] = await settledRun(group.id);
  const d = await runDetail(run.id);
  assert.equal(d.status, 'finished');
  assert.equal(d.endReason, 'final');
  const sends = d.steps.filter((s: any) => s.name === 'send_message');
  assert.equal(sends.length, 2);
  assert.match(sends[1].resultSummary, /"deliveryStatus":"sent"/);
  assert.equal((await agent.state()).calls.audit, 1);
  assert.equal((await gw.state()).messages.filter((m: any) => m.groupId === group.gatewayGroupId && m.text.startsWith('回复：')).length, 1);
});

test('S6: bad JSON then unknown tool then end_turn → ends cleanly, every step has kind + rawResponse', async () => {
  const { group } = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'bad' });
  await gw.inject(group.gatewayGroupId, 'trigger');
  const [run] = await settledRun(group.id);
  const d = await runDetail(run.id);
  assert.ok(['final', 'budget_exhausted', 'protocol_errors'].includes(d.endReason));
  assert.deepEqual(d.steps.map((s: any) => s.kind), ['protocol_error', 'tool_use', 'final']);
  assert.equal(d.steps[0].errorCode, 'BAD_JSON');
  assert.equal(d.steps[0].toolUseId, null);
  assert.equal(d.steps[1].errorCode, 'UNKNOWN_TOOL');
  assert.ok(d.steps.every((s: any) => typeof s.rawResponse === 'string' && s.rawResponse.length > 0));
  assert.equal((await http('GET', `${B}/api/health`)).status, 200, 'service still up');
});

test('A5: garbage forever → failed/protocol_errors after 3; endless tool calls → budget_exhausted at 12', async () => {
  const g1 = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'garbage' });
  await gw.inject(g1.group.gatewayGroupId, 'x');
  const [r1] = await settledRun(g1.group.id);
  assert.equal(r1.endReason, 'protocol_errors');
  assert.equal((await runDetail(r1.id)).steps.length, 3);

  const g2 = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'loop' });
  await gw.inject(g2.group.gatewayGroupId, 'y');
  const [r2] = await settledRun(g2.group.id);
  assert.equal(r2.endReason, 'budget_exhausted');
  assert.equal((await runDetail(r2.id)).steps.length, 12);
});

test('A5: audit never answers → run blocked, tool not executed', async () => {
  const { group } = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'normal', auditMode: '500' });
  await gw.inject(group.gatewayGroupId, 'hi');
  const [run] = await settledRun(group.id);
  assert.equal(run.status, 'blocked');
  assert.equal(run.endReason, 'audit_blocked');
  assert.equal((await agent.state()).calls.audit, 3);
  assert.equal((await gw.state()).messages.filter((m: any) => m.groupId === group.gatewayGroupId && m.text.startsWith('收到：')).length, 0);
});

test('A5: messages arriving mid-run are batched into exactly one follow-up run', async () => {
  const { group } = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'normal', turnDelayMs: 700 });
  await gw.inject(group.gatewayGroupId, 'first');
  await waitFor(async () => (await runsOf(group.id)).length === 1, 5_000, 'first run');
  await gw.inject(group.gatewayGroupId, 'second');
  await gw.inject(group.gatewayGroupId, 'third');
  const runs = await settledRun(group.id, 2);
  await sleep(500);
  assert.equal((await runsOf(group.id)).length, 2);
  const next = await runDetail(runs[0].id);
  assert.deepEqual(next.triggerMessages.map((m: any) => m.text), ['second', 'third']);
});

test('A5.8: backend killed mid-run → same run resumes and finishes, message sent exactly once', async () => {
  const { group } = await makeGroup(token, { agentEnabled: true });
  await agent.control({ mode: 'normal', turnDelayMs: 1500 });
  await gw.inject(group.gatewayGroupId, 'crash test');
  const run = await waitFor(async () => (await runsOf(group.id))[0], 5_000, 'run created');
  await waitFor(async () => (await runDetail(run.id)).steps.length >= 2, 10_000, 'send step recorded'); // inside/after send_message
  await killBackend();
  await sleep(500);
  await startBackend();
  const [done] = await settledRun(group.id);
  assert.equal(done.id, run.id, 'same runId');
  assert.equal(done.endReason, 'final');
  assert.equal((await gw.state()).messages.filter((m: any) => m.text === '收到：crash test').length, 1);
  const d = await runDetail(run.id);
  assert.equal(d.steps.find((s: any) => s.name === 'send_message').isError, false);
});

// ------------------------------------------------------------------ S7, S8 (B1)

const SEQ = {
  name: 'launch',
  steps: [
    { index: 1, accountRole: 'admin', text: '{event} 将于 {time} 开始', delaySeconds: 0 },
    { index: 2, accountRole: 'member', text: '{event} 资料在 {location}', delaySeconds: 1 },
    { index: 3, accountRole: 'admin', text: '最后提醒 {event} @ {room}', delaySeconds: 1 },
  ],
};

test('S7: concurrent starts → exactly one 201 and one 409', async () => {
  const { group } = await makeGroup(token);
  const seq = (await a.post('/api/sequences', SEQ)).body.id;
  const body = { sequenceId: seq, vars: { event: '发布会', time: '10点', location: 'A', room: 'B' }, stepVars: {} };
  const rs = await Promise.all([a.post(`/api/groups/${group.id}/sequence-runs`, body), a.post(`/api/groups/${group.id}/sequence-runs`, body)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
  assert.equal(rs.find((r) => r.status === 409)!.body.error.code, 'SEQUENCE_ALREADY_RUNNING');
  const runId = rs.find((r) => r.status === 201)!.body.runId;
  const run = await waitFor(async () => { const r = (await a.get(`/api/sequence-runs/${runId}`)).body; return r.status !== 'running' && r; }, 15_000, 'sequence finish');
  assert.equal(run.status, 'finished');
  assert.deepEqual(run.steps.map((s: any) => s.status), ['sent', 'sent', 'sent']);
});

test('S8: unresolved placeholder at step 3 → 422 with stepIndex/key, nothing sent, nothing left running', async () => {
  const { group } = await makeGroup(token);
  const seq = (await a.post('/api/sequences', SEQ)).body.id;
  const sentInto = async () => (await gw.state()).messages.filter((m: any) => m.groupId === group.gatewayGroupId).length;
  const before = await sentInto();
  const r = await a.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: seq, vars: { event: 'E', time: 'T', room: '' }, stepVars: { 2: { location: 'L' } } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'UNRESOLVED_PLACEHOLDER');
  assert.equal(r.body.error.stepIndex, 3);
  assert.equal(r.body.error.key, 'room');
  await sleep(500);
  assert.equal(await sentInto(), before);
  assert.equal((await a.get(`/api/groups/${group.id}`)).body.activeSequenceRunId, null);
  // stepVars carry forward and report their origin step
  const ok = await a.post(`/api/sequences/${seq}/precheck`, { vars: { event: 'E', time: 'T', location: 'default-loc' }, stepVars: { 2: { location: 'L2', room: 'R' }, 3: { location: '' } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.steps[2].varSources, { event: 'default', room: 'step:2' });
  assert.equal(ok.body.steps[1].resolvedVars.location, 'L2');
  assert.equal((await a.post(`/api/groups/${group.id}/sequence-runs`, { sequenceId: seq, vars: { event: 'E', time: 'T', location: 'L', room: 'R' }, stepVars: {} })).status, 201);
});

// ------------------------------------------------------------------ B2, B3

test('B2: leave-all with one failing member → job failed, creator stays, tables match the gateway', async () => {
  const { group, member, creator } = await makeGroup(token);
  await gw.control({ leaveFailFor: [member] });
  const { jobId } = (await a.post(`/api/groups/${group.id}/leave-all`)).body;
  const job = await waitFor(async () => { const j = (await a.get(`/api/jobs/${jobId}`)).body; return j.status !== 'running' && j; }, 10_000, 'leave job');
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.errors.map((e: any) => e.step), [`leave:${member}`]);
  const ours = (await a.get(`/api/groups/${group.id}`)).body.members.map((m: any) => m.platformUserId).sort();
  const theirs = (await gw.state()).groups[group.gatewayGroupId].members.filter((p: string) => p.startsWith('pu_')).sort();
  assert.deepEqual(ours, theirs);
  assert.ok(ours.includes(`pu_${creator}`));
});

test('B3: refresh rotates; reusing an old refresh token kills the whole session', async () => {
  const res = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  const cookie1 = res.headers.get('set-cookie')!.split(';')[0];
  assert.ok(!('refreshToken' in (await res.json())), 'refresh token never in the body');
  const r2 = await fetch(`${B}/api/auth/refresh`, { method: 'POST', headers: { cookie: cookie1 } });
  const cookie2 = r2.headers.get('set-cookie')!.split(';')[0];
  const access2 = (await r2.json()).accessToken;
  assert.equal((await api(access2).get('/api/accounts')).status, 200);
  assert.equal((await fetch(`${B}/api/auth/refresh`, { method: 'POST', headers: { cookie: cookie1 } })).status, 401, 'old token rejected');
  assert.equal((await fetch(`${B}/api/auth/refresh`, { method: 'POST', headers: { cookie: cookie2 } })).status, 401, 'newer token died with the session');
  assert.equal((await api(access2).get('/api/accounts')).status, 401, 'access tokens of the session revoked');
});
