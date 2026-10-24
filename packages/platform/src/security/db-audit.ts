/**
 * DB 監査ログ（pgAudit 形式）から decoy 専用 relation への読取りを検出する。SELECT をトリガーで検知する設計にはしない。
 * 実機の拡張・収集器は未導入（承認待ち）なので、入力は注入される行（テストは fixture）。出力は罠 ID と時刻だけ（文・値は持ち出さない）。
 */
export interface DbAuditLine { at: number; line: string }
export interface DbAuditSource { installed: boolean; read(): Promise<DbAuditLine[]> }
export const disabledDbAudit: DbAuditSource = { installed: false, read: async () => [] };

export interface DecoyRead { placementId: string; at: number }
export interface DecoyRelation { relation: string; placementId: string }

// AUDIT: SESSION,<stmt>,<substmt>,<class>,<command>,<object_type>,<object_name>,<statement>,<params>
const AUDIT_RE = /AUDIT: (?:SESSION|OBJECT),\d+,\d+,([A-Z]+),([A-Z ]+),([A-Z ]*),([^,]*),/;
const USER_RE = /\buser=([A-Za-z0-9_]{1,63})\b/;

/** 読取り系（READ）または書込み系（WRITE）が decoy relation に当たった行だけを返す。他の relation の通常アクセスは何も返さない。 */
export function detectDecoyReads(lines: readonly DbAuditLine[], decoys: readonly DecoyRelation[], opts: { allowedRoles?: readonly string[] } = {}): DecoyRead[] {
  const out: DecoyRead[] = [];
  const byRelation = new Map(decoys.map((d) => [d.relation.toLowerCase(), d.placementId]));
  const allowed = new Set(opts.allowedRoles ?? []);
  for (const l of lines) {
    const m = AUDIT_RE.exec(l.line);
    if (!m || (m[1] !== 'READ' && m[1] !== 'WRITE')) continue;
    const rel = m[4]!.replace(/^"|"$/g, '').toLowerCase();
    const placementId = byRelation.get(rel);
    if (!placementId) continue;
    const user = USER_RE.exec(l.line)?.[1];
    if (user && allowed.has(user)) continue;
    out.push({ placementId, at: l.at });
  }
  return out;
}
