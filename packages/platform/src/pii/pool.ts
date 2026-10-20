import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type PiiSql = ReturnType<typeof postgres>;

/** 個人情報 DB 専用のマイグレーションの置き場（本体 DB の apps/api/drizzle とは別）。 */
export const PII_MIGRATIONS_DIR = fileURLToPath(new URL('../../../../apps/api/drizzle-pii', import.meta.url));

export interface PiiPoolOptions {
  max?: number;
}

/**
 * 個人情報 DB への接続。接続文字列は apps/admin のサーバー側と取り込み口だけが持つ（apps/api は持たない）。
 * 管理画面は pii_admin、取り込み口は pii_ingest の URL を渡す。
 */
export function createPiiPool(url: string, options: PiiPoolOptions = {}): PiiSql {
  if (!url) throw new Error('PII database url is required');
  return postgres(url, { max: options.max ?? 5, onnotice: () => {} });
}

/** 個人情報 DB のオーナー（マイグレーション用）接続でだけ使う。適用済みの記録は pii_migrations に残す。 */
export async function applyPiiMigrations(sql: PiiSql, dir: string = PII_MIGRATIONS_DIR): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS pii_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const [done] = await sql`SELECT 1 FROM pii_migrations WHERE name = ${file}`;
    if (done) continue;
    const statements = (await readFile(`${dir}/${file}`, 'utf8'))
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const s of statements) await tx.unsafe(s);
      await tx`INSERT INTO pii_migrations (name) VALUES (${file})`;
    });
    applied.push(file);
  }
  return applied;
}
