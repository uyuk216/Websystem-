import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Missing required env var: DATABASE_URL');
const { db, sql } = createDb(url, { max: 1 });
await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
await sql.end();
console.log('migrations applied');
