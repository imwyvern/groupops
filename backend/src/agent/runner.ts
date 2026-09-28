/**
 * Agent run loop (spec A5).
 *
 * Durability model — every step is written before and after its side effect:
 *   1. The /agent/turn response is validated and recorded as a step. For tools with
 *      external effects (send_message, kick_user) the step starts in phase `executing`,
 *      and the assistant block is appended to the history in the same transaction.
 *   2. The effect itself is recorded durably *before* it happens (an outbox row for
 *      send_message, `effect.phase = 'calling'` for kick_user).
 *   3. The tool_result is appended and the step is marked `done`.
 * After a crash, a run resumes at the step in phase `executing` and finishes it by
 * *observing* the recorded effect (message status, gateway member list) instead of
 * repeating it — so nothing is performed twice and nothing that happened is reported
 * as failed. The same runId is reused, as the Agent service requires.
 *
 * Only one instance drives a run at a time: runs are leased (lease_owner/lease_until).
 */
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pool, tx, queueEvent } from '../db.js';
import { config } from '../config.js';
import { enqueueMessage } from '../outbox.js';
import { enterTerminal } from '../domain.js';
import { gateway, GatewayError } from '../gateway.js';
import { TOOLS, isKnownTool, validateInput, type ToolName } from './tools.js';
import { startNextRunIfPending } from './trigger.js';

const LEASE_SEC = 30;
const RESULT_MAX = 8 * 1024;
const RAW_MAX = 2 * 1024;
const cfg = config.agent;
const driving = new Set<string>();

// ------------------------------------------------------------------ scheduling

export async function startAgentRunner() {
  // Our previous incarnation's leases are ours to take back immediately.
  await pool.query('UPDATE agent_runs SET lease_owner = NULL, lease_until = NULL WHERE lease_owner = $1', [config.instanceId]);
  setInterval(claim, 250).unref();
}

async function claim() {
  const { rows } = await pool.query(
    `UPDATE agent_runs SET lease_owner = $1, lease_until = now() + make_interval(secs => $2),
            active_since = CASE WHEN lease_owner IS DISTINCT FROM $1 THEN now() ELSE active_since END
      WHERE id IN (SELECT id FROM agent_runs WHERE status = 'running'
                     AND (lease_owner IS NULL OR lease_until < now() OR lease_owner = $1)
                   FOR UPDATE SKIP LOCKED)
      RETURNING id`, [config.instanceId, LEASE_SEC]);
  for (const r of rows) {
    if (driving.has(r.id)) continue;
    driving.add(r.id);
    drive(r.id).catch((e) => console.error(`[agent] run ${r.id} crashed`, e)).finally(() => driving.delete(r.id));
  }
}

// ------------------------------------------------------------------ main loop

interface Run { id: string; group_id: string; status: string; history: any[]; step_count: number; protocol_error_streak: number; elapsed_now_ms: number; loaded_at: number }

/** `elapsed_now_ms` is computed by the database clock (the same clock that stamps active_since). */
const loadRun = async (id: string): Promise<Run> => {
  const r = (await pool.query(
    `SELECT *, elapsed_ms + extract(epoch from (now() - active_since)) * 1000 AS elapsed_now_ms FROM agent_runs WHERE id = $1`, [id])).rows[0];
  return { ...r, elapsed_now_ms: Number(r.elapsed_now_ms), loaded_at: Date.now() };
};
const elapsed = (r: Run) => r.elapsed_now_ms + (Date.now() - r.loaded_at);

async function drive(runId: string) {
  for (;;) {
    const run = await loadRun(runId);
    if (run.status !== 'running') return;
    await pool.query(`UPDATE agent_runs SET lease_until = now() + make_interval(secs => $2) WHERE id = $1`, [runId, LEASE_SEC]);

    const executing = (await pool.query(`SELECT * FROM agent_steps WHERE run_id = $1 AND phase = 'executing'`, [runId])).rows[0];
    if (executing) { await executeStep(run, executing); continue; }

    // A5.10: external state checked at every step boundary.
    const g = (await pool.query('SELECT status, agent_enabled FROM groups WHERE id = $1', [run.group_id])).rows[0];
    if (g.status !== 'active' || !g.agent_enabled) return endRun(run, 'cancelled', 'cancelled');
    if (run.step_count >= cfg.maxSteps) return endRun(run, 'failed', 'budget_exhausted');
    const remaining = cfg.wallClockMs - elapsed(run);
    if (remaining <= 0) return endRun(run, 'failed', 'wall_clock');

    await takeTurn(run, Math.min(cfg.turnTimeoutMs, remaining));
  }
}

async function takeTurn(run: Run, timeoutMs: number) {
  let raw = '';
  let status = 0;
  try {
    const res = await fetch(`${config.agentUrl}/agent/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: run.id, tools: TOOLS, messages: run.history }),
      signal: AbortSignal.timeout(timeoutMs),   // a late response is simply dropped
    });
    status = res.status;
    raw = await res.text();
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return protocolError(run, timedOut ? 'TURN_TIMEOUT' : 'BAD_JSON', timedOut ? `no response within ${timeoutMs}ms` : `request failed: ${e?.message}`, raw);
  }
  if (status < 200 || status >= 300) return protocolError(run, 'BAD_JSON', `HTTP ${status}`, raw);

  // Strict parse: fences or surrounding prose make it invalid (spec 2.2).
  let body: any;
  try { body = JSON.parse(raw); } catch { return protocolError(run, 'BAD_JSON', 'response body is not valid JSON', raw); }
  const shapeError = checkShape(body);
  if (shapeError) return protocolError(run, 'BAD_JSON', shapeError, raw);

  const block = body.content[0];
  if (body.stop_reason === 'end_turn') {
    return finishStep(run, { kind: 'final', raw, summary: block.text });
  }
  const usedIds = new Set(run.history.flatMap((m) => m.role === 'assistant' ? m.content.map((b: any) => b.id) : []));
  if (usedIds.has(block.id)) return protocolError(run, 'DUPLICATE_TOOL_USE_ID', `tool_use.id "${block.id}" was already used in this run`, raw);

  if (!isKnownTool(block.name)) {
    return recordImmediate(run, block, raw, errorResult('UNKNOWN_TOOL', `unknown tool "${block.name}"`, `use one of: ${TOOLS.map((t) => t.name).join(', ')}`), true);
  }
  const invalid = validateInput(block.name, block.input);
  if (invalid) return recordImmediate(run, block, raw, errorResult('INVALID_INPUT', invalid, 'fix the input to match input_schema'), true);

  switch (block.name as ToolName) {
    case 'finish':
      return finishStep(run, { kind: 'final', raw, summary: block.input.summary, block });
    case 'get_recent_messages':
      return recordImmediate(run, block, raw, await getRecentMessages(run, block.input.limit), false);
    default:
      return beginEffectStep(run, block, raw); // send_message / kick_user
  }
}

function checkShape(b: any): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body is not an object';
  if (b.stop_reason !== 'tool_use' && b.stop_reason !== 'end_turn') return 'missing or invalid stop_reason';
  if (!Array.isArray(b.content) || b.content.length !== 1) return 'content must contain exactly one block';
  const blk = b.content[0];
  if (b.stop_reason === 'end_turn') return blk?.type === 'text' && typeof blk.text === 'string' ? null : 'end_turn must carry one text block';
  if (blk?.type !== 'tool_use' || typeof blk.id !== 'string' || typeof blk.name !== 'string' || typeof blk.input !== 'object' || blk.input === null)
    return 'tool_use must carry one tool_use block with id, name and input';
  return null;
}

// ------------------------------------------------------------------ step recording

interface Result { content: string; isError: boolean; code: string | null; summary: string }
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
/** Truncate to at most n UTF-8 bytes without splitting a character (spec limits are in KB, and text is often CJK). */
const truncBytes = (s: string, n: number) => {
  if (bytes(s) <= n) return s;
  const cut = Buffer.from(s, 'utf8').subarray(0, n).toString('utf8');
  return cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut;
};
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s); // character count (resultSummary ≤ 200 字)
const summarize = (s: string) => trunc(s, 200);

function errorResult(code: string, message: string, hint?: string): Result {
  const content = JSON.stringify(hint ? { code, message, hint } : { code, message });
  return { content, isError: true, code, summary: summarize(`${code}: ${message}`) };
}
function okResult(obj: unknown): Result {
  let content = JSON.stringify(obj);
  if (bytes(content) > RESULT_MAX) content = JSON.stringify({ truncated: true, preview: truncBytes(content, RESULT_MAX - 200) });
  return { content, isError: false, code: null, summary: summarize(content) };
}

const toolResultMsg = (id: string, r: Result) => ({
  role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.content, ...(r.isError ? { is_error: true } : {}) }],
});

/** Persist a finished step and advance the run's counters, atomically. */
async function saveStep(c: pg.PoolClient, run: Run, idx: number, s: {
  kind: string; block?: any; raw?: string | null; result?: Result | null; audit?: string | null; phase?: 'executing' | 'done'; effect?: unknown;
}) {
  await c.query(
    `INSERT INTO agent_steps (run_id, idx, kind, phase, tool_use_id, name, input, result_summary, result_content, is_error, error_code, audit_verdict, effect, raw_response)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (run_id, idx) DO UPDATE SET phase = EXCLUDED.phase, result_summary = EXCLUDED.result_summary,
       result_content = EXCLUDED.result_content, is_error = EXCLUDED.is_error, error_code = EXCLUDED.error_code,
       audit_verdict = coalesce(EXCLUDED.audit_verdict, agent_steps.audit_verdict), effect = coalesce(EXCLUDED.effect, agent_steps.effect)`,
    [run.id, idx, s.kind, s.phase ?? 'done', s.block?.id ?? null, s.block?.name ?? null, s.block ? JSON.stringify(s.block.input) : null,
     s.result?.summary ?? null, s.result?.content ?? null, s.result?.isError ?? false, s.result?.code ?? null, s.audit ?? null,
     s.effect ? JSON.stringify(s.effect) : null, s.raw != null ? truncBytes(s.raw, RAW_MAX) : null]);
  queueEvent(c, 'agent_step', { runId: run.id, groupId: run.group_id, idx });
}

async function checkpoint(c: pg.PoolClient, run: Run, patch: { history: any[]; stepDelta: number; streak: number }) {
  await c.query(
    `UPDATE agent_runs SET history = $2, step_count = step_count + $3, protocol_error_streak = $4,
            elapsed_ms = elapsed_ms + (extract(epoch from (now() - active_since)) * 1000)::bigint, active_since = now()
      WHERE id = $1`, [run.id, JSON.stringify(patch.history), patch.stepDelta, patch.streak]);
}

async function protocolError(run: Run, code: string, sentence: string, raw: string) {
  const idx = run.step_count + 1;
  const history = [...run.history, { role: 'user', content: [{ type: 'text', text: `PROTOCOL_ERROR ${code}: ${sentence}` }] }];
  const streak = run.protocol_error_streak + 1;
  await tx(async (c) => {
    await saveStep(c, run, idx, { kind: 'protocol_error', raw, result: { content: '', isError: true, code, summary: summarize(sentence) } });
    await checkpoint(c, run, { history, stepDelta: 1, streak });
  });
  if (streak >= cfg.maxProtocolErrors) await endRun(await loadRun(run.id), 'failed', 'protocol_errors');
}

/** Tool calls answered without external effects (reads, and UNKNOWN_TOOL / INVALID_INPUT). */
async function recordImmediate(run: Run, block: any, raw: string, result: Result, isProtocolError: boolean) {
  const idx = run.step_count + 1;
  const history = [...run.history, { role: 'assistant', content: [block] }, toolResultMsg(block.id, result)];
  const streak = isProtocolError ? run.protocol_error_streak + 1 : 0;
  await tx(async (c) => {
    await saveStep(c, run, idx, { kind: 'tool_use', block, raw, result });
    await checkpoint(c, run, { history, stepDelta: 1, streak });
  });
  if (isProtocolError && streak >= cfg.maxProtocolErrors) await endRun(await loadRun(run.id), 'failed', 'protocol_errors');
}

async function finishStep(run: Run, s: { kind: 'final'; raw: string; summary: string; block?: any }) {
  const idx = run.step_count + 1;
  const result = s.block ? okResult({ ok: true }) : null;
  const history = s.block ? [...run.history, { role: 'assistant', content: [s.block] }, toolResultMsg(s.block.id, result!)] : run.history;
  await tx(async (c) => {
    await saveStep(c, run, idx, { kind: 'final', block: s.block, raw: s.raw, result });
    await checkpoint(c, run, { history, stepDelta: 1, streak: 0 });
  });
  await endRun(await loadRun(run.id), 'finished', 'final', s.summary);
}

async function beginEffectStep(run: Run, block: any, raw: string) {
  const idx = run.step_count + 1;
  const history = [...run.history, { role: 'assistant', content: [block] }];
  await tx(async (c) => {
    await saveStep(c, run, idx, { kind: 'tool_use', block, raw, phase: 'executing' });
    // step_count is advanced now: the /agent/turn round-trip already happened.
    await checkpoint(c, run, { history, stepDelta: 1, streak: 0 });
  });
}

async function completeEffectStep(run: Run, step: any, result: Result, audit?: string | null) {
  const block = { id: step.tool_use_id, name: step.name, input: step.input };
  await tx(async (c) => {
    await saveStep(c, run, step.idx, { kind: 'tool_use', block, result, audit, phase: 'done' });
    await checkpoint(c, run, { history: [...run.history, toolResultMsg(step.tool_use_id, result)], stepDelta: 0, streak: 0 });
  });
}

async function endRun(run: Run, status: string, endReason: string, summary?: string) {
  await tx(async (c) => {
    const r = await c.query(
      `UPDATE agent_runs SET status = $2, end_reason = $3, summary = coalesce($4, summary), finished_at = now(), lease_owner = NULL,
              elapsed_ms = elapsed_ms + (extract(epoch from (now() - active_since)) * 1000)::bigint, active_since = now()
        WHERE id = $1 AND status = 'running' RETURNING id`, [run.id, status, endReason, summary ?? null]);
    if (!r.rowCount) return;
    queueEvent(c, 'agent_run', { runId: run.id, groupId: run.group_id, status, endReason });
    if (status === 'cancelled') await c.query('DELETE FROM agent_pending WHERE group_id = $1', [run.group_id]);
    else await startNextRunIfPending(c, run.group_id);
  });
}

// ------------------------------------------------------------------ tools

async function getRecentMessages(run: Run, limit: number): Promise<Result> {
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  const { rows } = await pool.query(
    `SELECT msg_id, sender_platform_user_id, is_own, text, sent_at FROM messages
      WHERE group_id = $1 AND msg_id IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT $2`, [run.group_id, n]);
  let truncated = false;
  let messages = rows.reverse().map((r) => {
    const long = r.text.length > 500;
    truncated ||= long;
    return { msgId: r.msg_id, senderPlatformUserId: r.sender_platform_user_id, isOwn: r.is_own, text: long ? r.text.slice(0, 500) : r.text, sentAt: new Date(r.sent_at).toISOString() };
  });
  // A5.9: keep the tool_result under 8KB by dropping the oldest messages.
  while (messages.length && bytes(JSON.stringify({ messages, truncated, note: '' })) > RESULT_MAX - 200) { messages = messages.slice(1); truncated = true; }
  // A5.11: an identical consecutive call gets the same data plus a nudge to wrap up.
  const prev = [...run.history].reverse().find((m) => m.role === 'assistant')?.content?.[0];
  const repeated = prev?.name === 'get_recent_messages' && prev?.input?.limit === limit;
  return okResult(repeated ? { messages, truncated, note: 'Same query as your previous call; nothing else to read. Reply or call finish.' } : { messages, truncated });
}

async function executeStep(run: Run, step: any) {
  if (step.name === 'send_message') return executeSend(run, step);
  if (step.name === 'kick_user') return executeKick(run, step);
  throw new Error(`step ${step.idx}: unexpected executing tool ${step.name}`);
}

/**
 * Audit gate (A5.4). Returns 'pass' | 'fail', or null when three attempts produced no
 * clear verdict (in which case the run is already `blocked`).
 */
async function audit(run: Run, step: any, text: string): Promise<'pass' | 'fail' | null> {
  // A verdict obtained before a crash is reused: re-auditing could flip it, and running out of
  // attempts on resume would wrongly block a call that was already approved.
  if (step.audit_verdict === 'pass' || step.audit_verdict === 'fail') return step.audit_verdict;
  let outOfTime = false;
  for (let attempt = step.audit_attempts; attempt < 3; attempt++) {
    await pool.query('UPDATE agent_steps SET audit_attempts = $3 WHERE run_id = $1 AND idx = $2', [run.id, step.idx, attempt + 1]);
    if (elapsed(await loadRun(run.id)) >= cfg.wallClockMs) { outOfTime = true; break; }
    try {
      const res = await fetch(`${config.agentUrl}/agent/audit`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, groupId: run.group_id }), signal: AbortSignal.timeout(cfg.auditTimeoutMs),
      });
      if (!res.ok) continue;
      const verdict = JSON.parse(await res.text())?.verdict;
      if (verdict === 'pass' || verdict === 'fail') {
        await pool.query('UPDATE agent_steps SET audit_verdict = $3 WHERE run_id = $1 AND idx = $2', [run.id, step.idx, verdict]);
        return verdict;
      }
    } catch { /* timeout / bad JSON: not a verdict, try again */ }
  }
  const reason = outOfTime ? 'run hit the 60s wall clock while waiting for the audit; tool not executed'
                           : 'audit gave no verdict after 3 attempts; tool not executed';
  await tx(async (c) => {
    await c.query(`UPDATE agent_steps SET phase = 'done', is_error = true, error_code = $3, audit_verdict = 'unavailable', result_summary = $4
                    WHERE run_id = $1 AND idx = $2`, [run.id, step.idx, outOfTime ? 'WALL_CLOCK' : 'AUDIT_BLOCKED', reason]);
    queueEvent(c, 'agent_step', { runId: run.id, groupId: run.group_id, idx: step.idx });
  });
  // A5.2: the 60s budget includes audit time and ends the run as wall_clock; only "no verdict" blocks it.
  if (outOfTime) await endRun(await loadRun(run.id), 'failed', 'wall_clock');
  else await endRun(await loadRun(run.id), 'blocked', 'audit_blocked');
  return null;
}

async function pickAccount(groupId: string, roles: string[]) {
  const { rows } = await pool.query(
    `SELECT a.id, a.platform_user_id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
      WHERE gm.group_id = $1 AND a.status = 'online' AND gm.role = ANY($2)
      ORDER BY array_position(ARRAY['admin','creator','member'], gm.role), a.id LIMIT 1`, [groupId, roles]);
  return rows[0] as { id: string; platform_user_id: string } | undefined;
}

async function executeSend(run: Run, step: any) {
  const { text, idempotency_key: key } = step.input;
  let effect = step.effect as { clientMsgId: string; startedAt: number } | null;
  // Resuming after a restart: the send already happened (or is in the outbox). Give it a fresh 5s
  // from now — downtime must not turn an effect that did happen into SEND_TIMEOUT (A5.8).
  const resumed = !!effect;

  if (!effect) {
    // A5.7: a key already used in this run → report that message, no audit, no send.
    const prior = (await pool.query('SELECT client_msg_id FROM agent_idempotency WHERE run_id = $1 AND idempotency_key = $2', [run.id, key])).rows[0];
    if (prior) {
      const m = (await pool.query('SELECT delivery_status FROM messages WHERE client_msg_id = $1', [prior.client_msg_id])).rows[0];
      return completeEffectStep(run, step, okResult({ clientMsgId: prior.client_msg_id, deliveryStatus: m?.delivery_status ?? 'unknown' }));
    }
    const verdict = await audit(run, step, text);
    if (verdict === null) return;
    if (verdict === 'fail') return completeEffectStep(run, step, errorResult('AUDIT_REJECTED', 'the audit service rejected this message'), 'fail');
    const group = (await pool.query('SELECT status FROM groups WHERE id = $1', [run.group_id])).rows[0];
    if (group.status !== 'active') return completeEffectStep(run, step, errorResult('GROUP_UNREACHABLE', 'the group is not writable'), 'pass');
    const account = await pickAccount(run.group_id, ['admin', 'creator', 'member']);
    if (!account) return completeEffectStep(run, step, errorResult('NO_AVAILABLE_ACCOUNT', 'no online service account is a member of this group'), 'pass');

    // Record the effect, the idempotency key and the outbox row in one transaction.
    effect = { clientMsgId: `ag-${run.id}-${step.idx}`, startedAt: Date.now() };
    await tx(async (c) => {
      await enqueueMessage(c, { groupId: run.group_id, accountId: account.id, platformUserId: account.platform_user_id, clientMsgId: effect!.clientMsgId, text, source: 'agent' });
      await c.query('INSERT INTO agent_idempotency (run_id, idempotency_key, client_msg_id) VALUES ($1, $2, $3)', [run.id, key, effect!.clientMsgId]);
      await c.query(`UPDATE agent_steps SET effect = $3, audit_verdict = 'pass' WHERE run_id = $1 AND idx = $2`, [run.id, step.idx, JSON.stringify(effect)]);
    });
  }

  // Wait (≤5s from when the send was recorded) for the outbox to reach a verdict.
  const deadline = (resumed ? Date.now() : effect.startedAt) + 5_000;
  for (;;) {
    const m = (await pool.query('SELECT delivery_status, fail_code FROM messages WHERE client_msg_id = $1', [effect.clientMsgId])).rows[0];
    const s = m?.delivery_status;
    if (s === 'accepted' || s === 'sent') return completeEffectStep(run, step, okResult({ clientMsgId: effect.clientMsgId, deliveryStatus: s }), 'pass');
    if (s === 'failed' && (m.fail_code === 'GROUP_WRITE_FORBIDDEN' || m.fail_code === 'GROUP_UNREACHABLE'))
      return completeEffectStep(run, step, errorResult('GROUP_UNREACHABLE', 'the group is not writable'), 'pass');
    if (s === 'failed' || s === 'cancelled')
      return completeEffectStep(run, step, errorResult('SEND_FAILED', `message ${s}: ${m.fail_code}`), 'pass');
    if (Date.now() >= deadline)
      return completeEffectStep(run, step, errorResult('SEND_TIMEOUT', 'delivery could not be confirmed within 5s', 'reuse the same idempotency_key to check on it later'), 'pass');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function executeKick(run: Run, step: any) {
  const { platform_user_id: target, reason } = step.input;
  let effect = step.effect as { phase: 'calling'; byAccountId: string; attempts: number } | null;
  const group = (await pool.query('SELECT gateway_group_id, auto_kick_enabled FROM groups WHERE id = $1', [run.group_id])).rows[0];

  if (!effect) {
    if (!group.auto_kick_enabled) return completeEffectStep(run, step, errorResult('POLICY_DENIED', 'autoKickEnabled is off for this group'));
    const verdict = await audit(run, step, JSON.stringify({ action: 'kick', platform_user_id: target, reason }));
    if (verdict === null) return;
    if (verdict === 'fail') return completeEffectStep(run, step, errorResult('AUDIT_REJECTED', 'the audit service rejected this kick'), 'fail');
    const account = await pickAccount(run.group_id, ['creator', 'admin']);
    if (!account) return completeEffectStep(run, step, errorResult('NO_AVAILABLE_ACCOUNT', 'no online creator/admin account in this group'), 'pass');
    effect = { phase: 'calling', byAccountId: account.id, attempts: 0 };
  } else {
    // Resumed after a crash mid-kick: if the target is already gone, the kick happened.
    if (await isGone(group.gateway_group_id, target)) return completeEffectStep(run, step, okResult({ kicked: true }), 'pass');
  }

  while (effect.attempts < 2) {
    effect.attempts++;
    await pool.query(`UPDATE agent_steps SET effect = $3, audit_verdict = 'pass' WHERE run_id = $1 AND idx = $2`, [run.id, step.idx, JSON.stringify(effect)]);
    try {
      await gateway.kick(group.gateway_group_id, effect.byAccountId, target);
      return completeEffectStep(run, step, okResult({ kicked: true }), 'pass');
    } catch (e) {
      if (!(e instanceof GatewayError)) throw e;
      if (e.code === 'OWNER_LEFT' || e.code === 'NO_PERMISSION') return completeEffectStep(run, step, errorResult(e.code, e.message), 'pass');
      if (e.code === 'ACCOUNT_SUSPENDED' || e.code === 'SESSION_EXPIRED') {
        await tx((c) => enterTerminal(c, effect!.byAccountId, e.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired'));
        return completeEffectStep(run, step, errorResult('SEND_FAILED', `executing account became ${e.code}`), 'pass');
      }
      if (e.outcomeUnknown || e.status >= 500) {
        await new Promise((r) => setTimeout(r, 2_000)); // gateway converges within 2s
        if (await isGone(group.gateway_group_id, target)) return completeEffectStep(run, step, okResult({ kicked: true }), 'pass');
        continue; // not removed: the first call had no effect, so one more try is not a duplicate
      }
      return completeEffectStep(run, step, errorResult('NO_PERMISSION', `gateway refused: ${e.code}`), 'pass');
    }
  }
  return completeEffectStep(run, step, errorResult('SEND_TIMEOUT', 'kick outcome could not be confirmed'), 'pass');
}

async function isGone(gatewayGroupId: string, target: string) {
  try { return !(await gateway.members(gatewayGroupId)).data.some((m) => m.platformUserId === target); }
  catch { return false; }
}

export const _test = { checkShape, randomUUID };
