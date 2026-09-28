/**
 * Test harness: a throwaway database plus real processes (mock gateway, mock agent,
 * backend) on dedicated ports. Scenarios talk to them over HTTP only, exactly as the
 * console would, and can hard-kill / restart the backend to test recovery.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import pg from 'pg';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://groupops:groupops@localhost:55432/postgres';
const DB = 'groupops_test';
const DB_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`);
export const PORTS = { backend: 3100, gateway: 4101, agent: 4102 };
export const B = `http://localhost:${PORTS.backend}`;
export const GW = `http://localhost:${PORTS.gateway}`;
export const AG = `http://localhost:${PORTS.agent}`;

const procs: Record<string, ChildProcess> = {};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupops-test-'));

function start(name: string, cwd: string, script: string, env: Record<string, string>) {
  const p = spawn(process.execPath, ['--import', 'tsx', script], { cwd: path.join(ROOT, cwd), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(dataDir, `${name}.log`), { flags: 'a' });
  p.stdout!.pipe(log); p.stderr!.pipe(log);
  procs[name] = p;
  return p;
}

async function waitHttp(url: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url); return; } catch { await sleep(100); }
  }
  throw new Error(`timeout waiting for ${url}`);
}

const backendEnv = () => ({
  PORT: String(PORTS.backend), DATABASE_URL: DB_URL, GATEWAY_URL: GW, AGENT_URL: AG, DATA_DIR: dataDir,
  INSTANCE_ID: 'test-instance', AGENT_TURN_TIMEOUT_MS: '10000',
});

export async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  await new Promise<void>((resolve, reject) => {
    const m = spawn(process.execPath, ['--import', 'tsx', 'src/migrate-cli.ts'], { cwd: path.join(ROOT, 'backend'), env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'ignore' });
    m.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`))));
  });
  start('gateway', 'mocks', 'src/gateway.ts', { PORT: String(PORTS.gateway) });
  start('agent', 'mocks', 'src/agent.ts', { PORT: String(PORTS.agent) });
  await waitHttp(`${GW}/__state`);
  await waitHttp(`${AG}/__state`);
  await startBackend();
}

export async function startBackend() {
  start('backend', 'backend', 'src/main.ts', backendEnv());
  await waitHttp(`${B}/api/health`);
}
/** SIGKILL: no graceful shutdown, like a crash. */
export async function killBackend() {
  const p = procs.backend;
  if (!p || p.exitCode !== null) return;
  const exited = new Promise((r) => p.once('exit', r));
  p.kill('SIGKILL');
  await exited;
}
export async function teardown() {
  for (const p of Object.values(procs)) p.kill('SIGKILL');
  console.log(`[harness] process logs in ${dataDir}`);
}

// ------------------------------------------------------------------ helpers

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last}` : ''}`);
}

export async function http(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function login(username = 'admin') {
  const r = await http('POST', `${B}/api/auth/login`, { username, password: username });
  return r.body.accessToken as string;
}

export const api = (token: string) => ({
  get: (p: string) => http('GET', B + p, undefined, token),
  post: (p: string, body: unknown = {}) => http('POST', B + p, body, token),
  patch: (p: string, body: unknown) => http('PATCH', B + p, body, token),
});

export const gw = {
  control: (knobs: Record<string, unknown>) => http('POST', `${GW}/__control`, knobs),
  reset: () => http('POST', `${GW}/__reset`, {}),
  state: async () => (await http('GET', `${GW}/__state`)).body,
  inject: (groupId: string, text: string, senderPlatformUserId = 'ext_alice') => http('POST', `${GW}/__inject/message`, { groupId, text, senderPlatformUserId }),
  accountStatus: (accountId: string, status: string) => http('POST', `${GW}/__inject/account-status`, { accountId, status }),
};
export const agent = {
  control: (c: Record<string, unknown>) => http('POST', `${AG}/__control`, c),
  reset: () => http('POST', `${AG}/__reset`, {}),
  state: async () => (await http('GET', `${AG}/__state`)).body,
};

let accountCursor = 0;

/** A fresh group with three brand-new online accounts. */
export async function makeGroup(token: string, opts: { agentEnabled?: boolean } = {}) {
  const a = api(token);
  const ids = await freshAccounts(3);
  for (const id of ids) {
    const r = await a.post(`/api/accounts/${id}/connect`);
    if (r.status !== 200) throw new Error(`connect ${id}: ${JSON.stringify(r.body)}`);
  }
  const { body } = await a.post('/api/groups', { creatorAccountId: ids[0], memberAccountIds: [ids[1], ids[2]] });
  const job = await waitFor(async () => { const j = (await a.get(`/api/jobs/${body.jobId}`)).body; return j.status !== 'running' && j; }, 15_000, 'create-group job');
  if (job.status !== 'finished') throw new Error(`create group failed: ${JSON.stringify(job)}`);
  const group = (await a.get(`/api/groups/${job.groupId}`)).body;
  if (opts.agentEnabled) await a.patch(`/api/groups/${group.id}`, { agentEnabled: true });
  return { group, accounts: ids, creator: ids[0], admin: ids[1], member: ids[2] };
}

/** Each scenario gets untouched accounts so state (rate limits, terminal states) never leaks between tests. */
async function freshAccounts(n: number) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `t${String(++accountCursor).padStart(3, '0')}`;
    await c.query('INSERT INTO accounts (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    ids.push(id);
  }
  await c.end();
  return ids;
}

export async function dbQuery(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
