import { applyPiiMigrations, createPiiPool } from './pool.js';

const url = process.env.PII_OWNER_DATABASE_URL;
if (!url) throw new Error('Missing required env var: PII_OWNER_DATABASE_URL');
const sql = createPiiPool(url, { max: 1 });
const applied = await applyPiiMigrations(sql);
await sql.end();
console.log(applied.length ? `pii migrations applied: ${applied.join(', ')}` : 'pii migrations up to date');
