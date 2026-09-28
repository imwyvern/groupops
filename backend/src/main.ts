import { pool, tx } from './db.js';
import { config } from './config.js';
import { codeSchemaVersion, dbSchemaVersion } from './migrate.js';
import { buildApp } from './app.js';
import { startWs } from './ws.js';
import { startOutbox, nudge } from './outbox.js';
import { startStream } from './stream.js';
import { startJobs } from './jobs.js';
import { startAgentRunner } from './agent/runner.js';
import { startSequenceScheduler } from './sequences.js';
import { releaseExpiredRateLimits } from './domain.js';

// A0: refuse to start against a schema that is behind the code.
const dbVersion = await dbSchemaVersion(pool);
if (dbVersion < codeSchemaVersion()) {
  console.error(`[startup] database schema is at version ${dbVersion}, code expects ${codeSchemaVersion()}. Run \`pnpm migrate\` first.`);
  process.exit(1);
}

const app = buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });
await startWs(app.server);
await startOutbox();
await startJobs();
await startAgentRunner();
await startSequenceScheduler();
await startStream();

// Rate-limit expiry is persisted, so it survives restarts; this just polls for it.
setInterval(async () => {
  try { if (await tx((c) => releaseExpiredRateLimits(c))) nudge(); } catch (e) { console.error('[rate-limit]', e); }
}, 250).unref();

console.log(`[startup] listening on :${config.port} (schema v${dbVersion}, instance ${config.instanceId})`);
