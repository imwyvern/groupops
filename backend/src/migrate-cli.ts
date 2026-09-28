import { pool } from './db.js';
import { migrate, dbSchemaVersion } from './migrate.js';

await migrate(pool);
console.log(`[migrate] schema version ${await dbSchemaVersion(pool)}`);
await pool.end();
