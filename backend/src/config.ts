import os from 'node:os';
const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://groupops:groupops@localhost:55432/groupops',
  gatewayUrl: (process.env.GATEWAY_URL ?? 'http://localhost:4001').replace(/\/$/, ''),
  agentUrl: (process.env.AGENT_URL ?? 'http://localhost:4002').replace(/\/$/, ''),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  accessTtlSec: 15 * 60,
  refreshTtlSec: 7 * 24 * 3600,
  instanceId: process.env.INSTANCE_ID ?? `${os.hostname()}:${num(process.env.PORT, 3000)}`,
  agent: {
    turnTimeoutMs: num(process.env.AGENT_TURN_TIMEOUT_MS, 12_000), // spec: 10–15s, configurable
    auditTimeoutMs: num(process.env.AGENT_AUDIT_TIMEOUT_MS, 5_000),
    maxSteps: 12,
    wallClockMs: 60_000,
    maxProtocolErrors: 3,
  },
};
