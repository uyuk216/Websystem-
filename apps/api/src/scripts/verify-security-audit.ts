import { disabledAuditStorage } from 'platform';
import { loadConfig } from '../config.js';
import { assertOwnerBypassesRls, createDb } from '../db/client.js';
import { auditDeliveryStatus, verifyAgainstWorm } from '../security/system-audit.js';
import type { AuditStream } from '../security/audit-export.js';

// Server console only. The reader storage must use an INDEPENDENT read-only credential; none is installed yet, so this reports not installed.
// Output: counts and issue codes only (no row contents).
const reader = disabledAuditStorage;
const { db, sql } = createDb(loadConfig(process.env).databaseUrl);
try {
  await assertOwnerBypassesRls(db);
  let failed = false;
  for (const stream of ['security', 'admin'] as AuditStream[]) {
    const status = await auditDeliveryStatus(db, stream, { storage: reader });
    const v = await verifyAgainstWorm(db, stream, reader);
    console.log(`${stream}: delivery=${status.state} undelivered=${status.undelivered} worm_ok=${v.ok} issues=${v.issues.join(',') || '-'}`);
    if (!v.ok) failed = true;
  }
  if (!reader.installed) console.log('NOT INSTALLED: Object Lock storage is not configured. In-DB chain checks alone are NOT proof of WORM delivery.');
  process.exitCode = failed ? 2 : 0;
} finally { await sql.end(); }
