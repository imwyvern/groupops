import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { pool, tx, iso, queueEvent } from './db.js';
import { ApiError, badRequest, conflict, notFound, installErrorHandling } from './errors.js';
import { registerAuth } from './auth.js';
import { codeSchemaVersion } from './migrate.js';
import { gateway, GatewayError } from './gateway.js';
import { ACCOUNT_STATUSES, enterTerminal, isLegal, transitionAccount, type AccountStatus } from './domain.js';
import { enqueueMessage } from './outbox.js';
import { createJob } from './jobs.js';
import { resolveSequence, startSequenceRun, validateSequence } from './sequences.js';

export function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
  app.register(cookie);
  installErrorHandling(app);
  registerAuth(app);

  app.get('/api/health', async () => ({ ok: true, schemaVersion: codeSchemaVersion() }));

  // ------------------------------------------------------------ accounts (A1)
  const accountView = (r: any) => ({ id: r.id, status: r.status, platformUserId: r.platform_user_id, rateLimitedUntil: iso(r.rate_limited_until) });

  app.get('/api/accounts', async () => (await pool.query('SELECT * FROM accounts ORDER BY id')).rows.map(accountView));

  app.post('/api/accounts/:id/connect', async (req) => {
    const { id } = req.params as { id: string };
    const cur = (await pool.query('SELECT status FROM accounts WHERE id = $1', [id])).rows[0];
    if (!cur) throw notFound('ACCOUNT_NOT_FOUND');
    if (!isLegal(cur.status, 'online') || cur.status === 'rate_limited') throw conflict('ILLEGAL_TRANSITION', `cannot connect from ${cur.status}`);
    return connectAccount(id, cur.status);
  });

  app.post('/api/accounts/:id/transition', async (req) => {
    const { id } = req.params as { id: string };
    const { to, expectedFrom } = (req.body ?? {}) as any;
    if (!ACCOUNT_STATUSES.includes(to) || !ACCOUNT_STATUSES.includes(expectedFrom)) throw badRequest('`to` and `expectedFrom` must be valid account statuses');
    if (to === 'online' && isLegal(expectedFrom, to)) return connectAccount(id, expectedFrom); // going online needs a gateway session
    // An operator-set rate_limited still needs an expiry, or it would never auto-recover (A1).
    const r = await tx((c) => transitionAccount(c, id, expectedFrom, to, to === 'rate_limited' ? { rateLimitedForSec: 60 } : {}));
    if (!r.ok) throw r.code === 'ACCOUNT_NOT_FOUND' ? notFound(r.code) : conflict(r.code, undefined, r.current ? { currentStatus: r.current } : {});
    if (to === 'disconnected' || to === 'idle') await gateway.disconnect(id).catch(() => {}); // best effort; not subject to rate limits
    return { status: to };
  });

  async function connectAccount(id: string, expectedFrom: AccountStatus) {
    // Check the expected state before any gateway side effect, so a stale expectedFrom answers
    // CAS_CONFLICT (not a gateway error) and doesn't leave the gateway session open behind our back.
    const cur = (await pool.query('SELECT status FROM accounts WHERE id = $1', [id])).rows[0];
    if (!cur) throw notFound('ACCOUNT_NOT_FOUND');
    if (cur.status !== expectedFrom) throw conflict('CAS_CONFLICT', undefined, { currentStatus: cur.status });
    let platformUserId: string;
    try { platformUserId = (await gateway.connect(id)).data.platformUserId; }
    catch (e) {
      if (e instanceof GatewayError && (e.code === 'ACCOUNT_SUSPENDED' || e.code === 'SESSION_EXPIRED')) {
        await tx((c) => enterTerminal(c, id, e.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired'));
        throw conflict('ACCOUNT_TERMINAL', `gateway reports ${e.code}`);
      }
      throw new ApiError(502, 'GATEWAY_ERROR', e instanceof Error ? e.message : String(e));
    }
    const r = await tx((c) => transitionAccount(c, id, expectedFrom, 'online', { platformUserId }));
    if (!r.ok) {
      // Lost the race after connecting: if the winner left the account offline, close the session we opened.
      if (r.current && r.current !== 'online' && r.current !== 'rate_limited') await gateway.disconnect(id).catch(() => {});
      throw r.code === 'ACCOUNT_NOT_FOUND' ? notFound(r.code) : conflict(r.code, undefined, r.current ? { currentStatus: r.current } : {});
    }
    return { status: 'online', platformUserId };
  }

  // ------------------------------------------------------------ groups (A3, B2)
  async function groupView(g: any) {
    const members = (await pool.query(
      `SELECT account_id, platform_user_id, role FROM group_members WHERE group_id = $1
        ORDER BY array_position(ARRAY['creator','admin','member'], role), account_id`, [g.id])).rows;
    const seq = (await pool.query(`SELECT id FROM sequence_runs WHERE group_id = $1 AND status = 'running'`, [g.id])).rows[0];
    const run = (await pool.query(`SELECT id FROM agent_runs WHERE group_id = $1 AND status = 'running'`, [g.id])).rows[0];
    return {
      id: g.id, gatewayGroupId: g.gateway_group_id, status: g.status, creatorAccountId: g.creator_account_id,
      agentEnabled: g.agent_enabled, autoKickEnabled: g.auto_kick_enabled,
      members: members.map((m) => ({ accountId: m.account_id, platformUserId: m.platform_user_id, role: m.role })),
      activeSequenceRunId: seq?.id ?? null, activeAgentRunId: run?.id ?? null,
    };
  }
  const loadGroup = async (id: string) => {
    if (!isUuid(id)) throw notFound('GROUP_NOT_FOUND');
    const g = (await pool.query('SELECT * FROM groups WHERE id = $1', [id])).rows[0];
    if (!g) throw notFound('GROUP_NOT_FOUND');
    return g;
  };

  app.get('/api/groups', async () => Promise.all((await pool.query('SELECT * FROM groups ORDER BY created_at DESC')).rows.map(groupView)));
  app.get('/api/groups/:id', async (req) => groupView(await loadGroup((req.params as any).id)));

  app.post('/api/groups', async (req, reply) => {
    const { creatorAccountId, memberAccountIds } = (req.body ?? {}) as any;
    if (typeof creatorAccountId !== 'string' || !Array.isArray(memberAccountIds) || memberAccountIds.length < 1
      || memberAccountIds.some((m: unknown) => typeof m !== 'string') || new Set(memberAccountIds).size !== memberAccountIds.length
      || memberAccountIds.includes(creatorAccountId)) {
      throw badRequest('creatorAccountId and a non-empty, duplicate-free memberAccountIds (excluding the creator) are required');
    }
    const all = [creatorAccountId, ...memberAccountIds];
    const { rows } = await pool.query('SELECT id, status FROM accounts WHERE id = ANY($1)', [all]);
    const notOnline = all.filter((id) => rows.find((r) => r.id === id)?.status !== 'online');
    if (notOnline.length) throw new ApiError(422, 'ACCOUNT_NOT_ONLINE', 'all accounts must be online', { accountIds: notOnline });
    const jobId = await tx((c) => createJob(c, 'create_group', null, { creator: creatorAccountId, members: memberAccountIds, joins: {}, promoteCalls: 0 }));
    return reply.status(202).send({ jobId });
  });

  app.patch('/api/groups/:id', async (req) => {
    const g = await loadGroup((req.params as any).id);
    const { agentEnabled, autoKickEnabled } = (req.body ?? {}) as any;
    if ((agentEnabled !== undefined && typeof agentEnabled !== 'boolean') || (autoKickEnabled !== undefined && typeof autoKickEnabled !== 'boolean'))
      throw badRequest('agentEnabled / autoKickEnabled must be booleans');
    await tx(async (c) => {
      await c.query(`UPDATE groups SET agent_enabled = coalesce($2, agent_enabled), auto_kick_enabled = coalesce($3, auto_kick_enabled) WHERE id = $1`,
        [g.id, agentEnabled ?? null, autoKickEnabled ?? null]);
      if (agentEnabled === false) await c.query('DELETE FROM agent_pending WHERE group_id = $1', [g.id]);
      queueEvent(c, 'group_changed', { groupId: g.id });
    });
    return groupView(await loadGroup(g.id));
  });

  app.post('/api/groups/:id/send', async (req, reply) => {
    const g = await loadGroup((req.params as any).id);
    const { accountId, text } = (req.body ?? {}) as any;
    if (typeof accountId !== 'string' || typeof text !== 'string' || !text.trim()) throw badRequest('accountId and non-empty text are required');
    const acc = (await pool.query('SELECT status, platform_user_id FROM accounts WHERE id = $1', [accountId])).rows[0];
    if (!acc) throw notFound('ACCOUNT_NOT_FOUND');
    if (!['online', 'rate_limited'].includes(acc.status)) throw conflict('ACCOUNT_UNAVAILABLE', `account is ${acc.status}`);
    const member = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2', [g.id, accountId]);
    if (!member.rowCount) throw conflict('ACCOUNT_NOT_IN_GROUP');
    if (g.status !== 'active') throw conflict('GROUP_UNREACHABLE', `group is ${g.status}`);
    const clientMsgId = randomUUID();
    await tx((c) => enqueueMessage(c, { groupId: g.id, accountId, platformUserId: acc.platform_user_id, clientMsgId, text, source: 'operator' }));
    return reply.status(202).send({ clientMsgId });
  });

  app.post('/api/groups/:id/leave-all', async (req, reply) => {
    const g = await loadGroup((req.params as any).id);
    if (g.status === 'left') throw conflict('GROUP_ALREADY_LEFT');
    const jobId = await tx((c) => createJob(c, 'leave_all', g.id, {}));
    return reply.status(202).send({ jobId });
  });

  app.get('/api/jobs/:jobId', async (req) => {
    const id = (req.params as any).jobId;
    const j = isUuid(id) ? (await pool.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0] : null;
    if (!j) throw notFound('JOB_NOT_FOUND');
    return { id: j.id, kind: j.kind, groupId: j.group_id, status: j.status, errors: j.errors };
  });

  // ------------------------------------------------------------ timeline (A4)
  app.get('/api/groups/:id/messages', async (req) => {
    const g = await loadGroup((req.params as any).id);
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    let cursor: [string, number] | null = null;
    if (q.before) {
      try { cursor = JSON.parse(Buffer.from(q.before, 'base64url').toString()); } catch { throw badRequest('invalid cursor'); }
    }
    // Keyset pagination on (sent_at, id): rows inserted concurrently above the cursor can
    // never shift a page boundary, so "load older" has no duplicates or gaps.
    const { rows } = await pool.query(
      `SELECT * FROM messages WHERE group_id = $1 ${cursor ? 'AND (sent_at, id) < ($3::timestamptz, $4::bigint)' : ''}
        ORDER BY sent_at DESC, id DESC LIMIT $2`, cursor ? [g.id, limit + 1, cursor[0], cursor[1]] : [g.id, limit + 1]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((m) => ({
        id: m.id, msgId: m.msg_id, clientMsgId: m.client_msg_id, senderPlatformUserId: m.sender_platform_user_id, isOwn: m.is_own,
        text: m.text, sentAt: iso(m.sent_at), deliveryStatus: m.delivery_status, failCode: m.fail_code, mediaUrl: m.media_url,
        accountId: m.account_id, source: m.source ?? (m.is_own ? 'external' : null), // operator | agent | sequence; own echo with no outbox row = sent outside this system
      })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([iso(last.sent_at), last.id])).toString('base64url') : null,
    };
  });

  // ------------------------------------------------------------ agent runs (A5)
  const runView = (r: any) => ({ id: r.id, groupId: r.group_id, status: r.status, endReason: r.end_reason, summary: r.summary, stepCount: r.step_count, createdAt: iso(r.created_at), finishedAt: iso(r.finished_at) });
  app.get('/api/groups/:id/agent-runs', async (req) => {
    const g = await loadGroup((req.params as any).id);
    return (await pool.query('SELECT * FROM agent_runs WHERE group_id = $1 ORDER BY created_at DESC LIMIT 50', [g.id])).rows.map(runView);
  });
  app.get('/api/agent-runs/:id', async (req) => {
    const id = (req.params as any).id;
    const r = isUuid(id) ? (await pool.query('SELECT * FROM agent_runs WHERE id = $1', [id])).rows[0] : null;
    if (!r) throw notFound('AGENT_RUN_NOT_FOUND');
    const steps = (await pool.query('SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY idx', [id])).rows;
    return {
      ...runView(r), triggerMessages: r.trigger_messages,
      steps: steps.map((s) => ({
        index: s.idx, kind: s.kind, phase: s.phase, toolUseId: s.tool_use_id, name: s.name, input: s.input, resultSummary: s.result_summary,
        isError: s.is_error, errorCode: s.error_code, auditVerdict: s.audit_verdict, rawResponse: s.raw_response,
      })),
    };
  });

  // ------------------------------------------------------------ sequences (B1)
  const loadSequence = async (id: string) => {
    const s = isUuid(id) ? (await pool.query('SELECT * FROM sequences WHERE id = $1', [id])).rows[0] : null;
    if (!s) throw notFound('SEQUENCE_NOT_FOUND');
    return s;
  };
  const parseVars = (body: any) => {
    const vars = body?.vars ?? {}, stepVars = body?.stepVars ?? {};
    const isMap = (o: any) => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => typeof v === 'string');
    if (!isMap(vars) || typeof stepVars !== 'object' || Array.isArray(stepVars) || !Object.values(stepVars).every(isMap))
      throw badRequest('vars must be a string map; stepVars a map of step index → string map');
    return { vars, stepVars };
  };
  const unresolved = (r: { stepIndex: number; key: string }) =>
    new ApiError(422, 'UNRESOLVED_PLACEHOLDER', `step ${r.stepIndex}: placeholder {${r.key}} has no value`, { stepIndex: r.stepIndex, key: r.key });

  app.get('/api/sequences', async () => (await pool.query('SELECT id, name, steps FROM sequences ORDER BY created_at DESC')).rows);
  app.post('/api/sequences', async (req, reply) => {
    const err = validateSequence(req.body);
    if (err) throw badRequest(err);
    const id = randomUUID();
    const b = req.body as any;
    await pool.query('INSERT INTO sequences (id, name, steps) VALUES ($1, $2, $3)', [id, b.name, JSON.stringify(b.steps)]);
    return reply.status(201).send({ id });
  });
  app.post('/api/sequences/:id/precheck', async (req) => {
    const s = await loadSequence((req.params as any).id);
    const { vars, stepVars } = parseVars(req.body);
    const r = resolveSequence(s.steps, vars, stepVars);
    if (!r.ok) throw unresolved(r);
    return { steps: r.steps.map((x) => ({ index: x.index, text: x.text, resolvedText: x.resolvedText, resolvedVars: x.resolvedVars, varSources: x.varSources })) };
  });

  app.post('/api/groups/:id/sequence-runs', async (req, reply) => {
    const g = await loadGroup((req.params as any).id);
    const body = (req.body ?? {}) as any;
    const s = await loadSequence(body.sequenceId);
    const { vars, stepVars } = parseVars(body);
    const r = resolveSequence(s.steps, vars, stepVars);
    if (!r.ok) throw unresolved(r); // precheck fails before anything is written
    if (g.status !== 'active') throw conflict('GROUP_UNREACHABLE', `group is ${g.status}`);
    try {
      const runId = await tx((c) => startSequenceRun(c, g.id, s, r.steps));
      return reply.status(201).send({ runId });
    } catch (e: any) {
      if (e?.code === '23505' && e?.constraint === 'sequence_runs_one_running') throw conflict('SEQUENCE_ALREADY_RUNNING');
      throw e;
    }
  });
  app.get('/api/groups/:id/sequence-runs', async (req) => {
    const g = await loadGroup((req.params as any).id);
    return (await pool.query('SELECT * FROM sequence_runs WHERE group_id = $1 ORDER BY created_at DESC LIMIT 50', [g.id])).rows
      .map((r) => ({ id: r.id, status: r.status, currentStepIndex: r.current_step_index, sequenceId: r.sequence_id, createdAt: iso(r.created_at) }));
  });
  app.get('/api/sequence-runs/:id', async (req) => {
    const id = (req.params as any).id;
    const r = isUuid(id) ? (await pool.query('SELECT * FROM sequence_runs WHERE id = $1', [id])).rows[0] : null;
    if (!r) throw notFound('SEQUENCE_RUN_NOT_FOUND');
    const steps = (await pool.query('SELECT * FROM sequence_run_steps WHERE run_id = $1 ORDER BY idx', [id])).rows;
    return {
      id: r.id, groupId: r.group_id, sequenceId: r.sequence_id, status: r.status, currentStepIndex: r.current_step_index,
      steps: steps.map((s) => ({
        index: s.idx, status: s.status, scheduledAt: iso(s.scheduled_at), sentAt: iso(s.sent_at), clientMsgId: s.client_msg_id,
        text: s.text, resolvedVars: s.resolved_vars, varSources: s.var_sources,
      })),
    };
  });

  return app;
}

const isUuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
