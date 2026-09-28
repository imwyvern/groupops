/**
 * Asynchronous group jobs (A3 create, B2 leave-all). Progress lives in `jobs.state`
 * so a job interrupted by a restart continues where it stopped. Jobs are leased like
 * agent runs so only one instance drives each.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool, tx, queueEvent } from './db.js';
import { config } from './config.js';
import { gateway, GatewayError } from './gateway.js';
import { enterTerminal } from './domain.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JOIN_TIMEOUT_MS = 10_000;
const driving = new Set<string>();

interface Job { id: string; kind: string; group_id: string | null; state: any; errors: { step: string; code: string }[] }

export async function createJob(c: pg.PoolClient, kind: string, groupId: string | null, state: unknown) {
  const id = randomUUID();
  await c.query('INSERT INTO jobs (id, kind, group_id, state) VALUES ($1, $2, $3, $4)', [id, kind, groupId, JSON.stringify(state)]);
  setImmediate(claim);
  return id;
}

export async function startJobs() {
  await pool.query(`UPDATE jobs SET state = state - 'lease' WHERE status = 'running' AND state->'lease'->>'owner' = $1`, [config.instanceId]);
  setInterval(claim, 500).unref();
}

async function claim() {
  const { rows } = await pool.query(
    `UPDATE jobs SET state = jsonb_set(state, '{lease}', jsonb_build_object('owner', $1::text, 'until', extract(epoch from now()) + 30))
      WHERE id IN (SELECT id FROM jobs WHERE status = 'running'
                     AND (state->'lease' IS NULL OR (state->'lease'->>'until')::float < extract(epoch from now()) OR state->'lease'->>'owner' = $1)
                   FOR UPDATE SKIP LOCKED)
      RETURNING *`, [config.instanceId]);
  for (const job of rows as Job[]) {
    if (driving.has(job.id)) continue;
    driving.add(job.id);
    const run = job.kind === 'create_group' ? runCreateGroup : runLeaveAll;
    run(job).catch((e) => console.error(`[job] ${job.id}`, e)).finally(() => driving.delete(job.id));
  }
}

const save = (job: Job) => pool.query(
  `UPDATE jobs SET state = $2 || jsonb_build_object('lease', jsonb_build_object('owner', $3::text, 'until', extract(epoch from now()) + 30)),
          errors = $4, group_id = $5, updated_at = now() WHERE id = $1`,
  [job.id, JSON.stringify(job.state), config.instanceId, JSON.stringify(job.errors), job.group_id]);

async function finish(job: Job) {
  await tx(async (c) => {
    await c.query(`UPDATE jobs SET status = $2, errors = $3, state = state - 'lease', updated_at = now() WHERE id = $1`,
      [job.id, job.errors.length ? 'failed' : 'finished', JSON.stringify(job.errors)]);
    if (job.group_id) queueEvent(c, 'group_changed', { groupId: job.group_id });
  });
}

/** Account-level gateway errors are facts about the account, whatever step saw them. */
async function absorbAccountError(e: unknown, accountId: string) {
  if (e instanceof GatewayError && (e.code === 'ACCOUNT_SUSPENDED' || e.code === 'SESSION_EXPIRED'))
    await tx((c) => enterTerminal(c, accountId, e.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired'));
}
const codeOf = (e: unknown) => (e instanceof GatewayError ? e.code : 'INTERNAL');

// ------------------------------------------------------------------ create group

interface CreateState {
  creator: string; members: string[];
  gatewayGroupId?: string; invite?: { link: string; readyAt: number }; inviteRenewed?: boolean;
  joins: Record<string, { requestedAt?: number; joined?: boolean; failed?: boolean }>;
  promoteCalls: number; promoted?: boolean;
}

async function runCreateGroup(job: Job) {
  const s: CreateState = job.state;
  const fail = async (step: string, code: string) => { job.errors.push({ step, code }); await save(job); };

  // 1. create — the group row is written together with the creator's membership.
  if (!s.gatewayGroupId) {
    try {
      const { data } = await gateway.createGroup(s.creator);
      s.gatewayGroupId = data.groupId;
      const groupId = randomUUID();
      await tx(async (c) => {
        await c.query(`INSERT INTO groups (id, gateway_group_id, creator_account_id) VALUES ($1, $2, $3)`, [groupId, data.groupId, s.creator]);
        const puid = (await c.query('SELECT platform_user_id FROM accounts WHERE id = $1', [s.creator])).rows[0].platform_user_id;
        await c.query(`INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1, $2, $3, 'creator')`, [groupId, s.creator, puid]);
        await c.query(`UPDATE jobs SET group_id = $2, state = $3 WHERE id = $1`, [job.id, groupId, JSON.stringify(s)]);
      });
      job.group_id = groupId;
    } catch (e) {
      await absorbAccountError(e, s.creator);
      await fail('create', codeOf(e));
      return finish(job);
    }
  }

  // 2. invite link
  const newInvite = async () => {
    const { data } = await gateway.invite(s.gatewayGroupId!);
    s.invite = { link: data.inviteLink, readyAt: Date.now() + data.readyAfterMs };
    await save(job);
  };
  if (!s.invite) {
    try { await newInvite(); } catch (e) { await fail('invite', codeOf(e)); return finish(job); }
  }

  // 3. join requests (B2: INVITE_NOT_READY → wait; INVITE_EXPIRED → renew once; ALREADY_MEMBER → joined)
  for (const acc of s.members) {
    const j = (s.joins[acc] ??= {});
    if (j.requestedAt || j.joined || j.failed) continue;
    for (let attempt = 0; attempt < 20; attempt++) {
      const wait = s.invite!.readyAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        await gateway.join(s.gatewayGroupId!, acc, s.invite!.link);
        j.requestedAt = Date.now();
        break;
      } catch (e) {
        const code = codeOf(e);
        if (code === 'INVITE_NOT_READY') { s.invite!.readyAt = Math.max(s.invite!.readyAt, Date.now() + 500); continue; }
        if (code === 'INVITE_EXPIRED' && !s.inviteRenewed) {
          s.inviteRenewed = true;
          try { await newInvite(); continue; } catch (e2) { await fail('invite', codeOf(e2)); j.failed = true; break; }
        }
        if (code === 'ALREADY_MEMBER') { await recordMember(job.group_id!, acc); j.joined = true; break; }
        await absorbAccountError(e, acc);
        await fail(`join:${acc}`, code);
        j.failed = true;
        break;
      }
    }
    if (!j.requestedAt && !j.joined && !j.failed) { j.failed = true; await fail(`join:${acc}`, 'INVITE_NOT_READY'); }
    await save(job);
  }

  // 4. wait for member_joined (≤10s each), promoting memberAccountIds[0] as soon as it is in.
  const admin = s.members[0];
  for (;;) {
    const members = new Set((await pool.query('SELECT account_id FROM group_members WHERE group_id = $1', [job.group_id])).rows.map((r) => r.account_id));
    for (const acc of s.members) {
      const j = s.joins[acc];
      if (j.failed || j.joined) continue;
      if (members.has(acc)) j.joined = true;
      else if (j.requestedAt && Date.now() - j.requestedAt > JOIN_TIMEOUT_MS) { j.failed = true; await fail(`join:${acc}`, 'JOIN_TIMEOUT'); }
    }
    if (s.joins[admin]?.joined && !s.promoted) await promote(job, s);
    if (s.members.every((a) => s.joins[a].joined || s.joins[a].failed) && (s.promoted || !s.joins[admin]?.joined)) break;
    await save(job);
    await sleep(100);
  }
  await save(job);
  return finish(job);
}

/** ≤2 promote calls in total: NOT_MEMBER_YET can only happen if we raced member_joined, so one retry suffices. */
async function promote(job: Job, s: CreateState) {
  const admin = s.members[0];
  while (s.promoteCalls < 2 && !s.promoted) {
    s.promoteCalls++;
    await save(job);
    try {
      await gateway.promote(s.gatewayGroupId!, s.creator, admin);
      s.promoted = true;
      await tx(async (c) => {
        await c.query(`UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND account_id = $2`, [job.group_id, admin]);
        queueEvent(c, 'member_changed', { groupId: job.group_id });
      });
    } catch (e) {
      if (codeOf(e) === 'NOT_MEMBER_YET' && s.promoteCalls < 2) { await sleep(1_000); continue; }
      job.errors.push({ step: 'promote', code: codeOf(e) });
      s.promoted = true; // give up; recorded as an error
    }
  }
}

async function recordMember(groupId: string, accountId: string) {
  await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
       SELECT $1, id, platform_user_id, 'member' FROM accounts WHERE id = $2 ON CONFLICT DO NOTHING`, [groupId, accountId]);
    if (r.rowCount) queueEvent(c, 'member_changed', { groupId });
  });
}

// ------------------------------------------------------------------ leave all (B2)

async function runLeaveAll(job: Job) {
  const s = job.state as { done: string[] };
  s.done ??= [];
  const g = (await pool.query('SELECT gateway_group_id, creator_account_id FROM groups WHERE id = $1', [job.group_id])).rows[0];
  const members = (await pool.query('SELECT account_id FROM group_members WHERE group_id = $1 ORDER BY account_id', [job.group_id])).rows.map((r) => r.account_id);
  const others = members.filter((a) => a !== g.creator_account_id);

  // Non-creators first; the creator must leave last or the others lose the ability to act.
  for (const acc of others) {
    if (s.done.includes(acc)) continue;
    try {
      await gateway.leave(g.gateway_group_id, acc);
      await removeMember(job.group_id!, acc);
      s.done.push(acc);
    } catch (e) {
      await absorbAccountError(e, acc);
      job.errors.push({ step: `leave:${acc}`, code: codeOf(e) });
    }
    await save(job);
  }
  if (!job.errors.length && members.includes(g.creator_account_id)) {
    try {
      await gateway.leave(g.gateway_group_id, g.creator_account_id);
      await removeMember(job.group_id!, g.creator_account_id);
    } catch (e) {
      await absorbAccountError(e, g.creator_account_id);
      job.errors.push({ step: `leave:${g.creator_account_id}`, code: codeOf(e) });
    }
  }
  if (!job.errors.length) {
    await tx(async (c) => {
      await c.query(`UPDATE groups SET status = 'left' WHERE id = $1`, [job.group_id]);
      await c.query('DELETE FROM group_members WHERE group_id = $1', [job.group_id]);
    });
  } else {
    await reconcileMembers(job.group_id!, g.gateway_group_id);
  }
  return finish(job);
}

async function removeMember(groupId: string, accountId: string) {
  await tx(async (c) => {
    await c.query('DELETE FROM group_members WHERE group_id = $1 AND account_id = $2', [groupId, accountId]);
    queueEvent(c, 'member_changed', { groupId });
  });
}

/** Make our member table match the gateway's list (for service accounts). */
async function reconcileMembers(groupId: string, gatewayGroupId: string) {
  let list: { platformUserId: string }[];
  try { list = (await gateway.members(gatewayGroupId)).data; } catch { return; }
  const present = list.map((m) => m.platformUserId);
  await tx(async (c) => {
    await c.query('DELETE FROM group_members WHERE group_id = $1 AND NOT (platform_user_id = ANY($2))', [groupId, present]);
    queueEvent(c, 'member_changed', { groupId });
  });
}
