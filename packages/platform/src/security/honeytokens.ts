import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ハニートークン 7 種の配置 descriptor と registry（Task 7）。registry が持つのは値の HMAC・種別・匿名の配置 ID・有効期間だけ。
 * 値そのものは承認済みの配備時に `generateHoneytokenValue` で作り、リポジトリ・ログ・本番資格情報には置かない。
 * 偽の鍵は実クラウドの権限を持たないので、実クラウドに対する使用は観測できない（独自の偽認証口への使用だけを検知する）。
 */
export const HONEYTOKEN_KINDS = [
  'fake_env_key', // ① 設定 / env / コンテナ内の偽鍵
  'decoy_admin_row', // ② 本体 DB の偽管理者（権限なし）
  'decoy_student_row', // ③ 個人情報 DB の偽学生（完全な合成データ）
  'fake_repo_key', // ④ リポジトリ奥 / バックアップの偽 API key
  'decoy_internal_url', // ⑤ 偽の内部 URL
  'decoy_dotenv', // ⑥ 本体ドメインの /.env（偽鍵だけ）
  'decoy_admin_login', // ⑦ 偽 /admin/login
] as const;
export type HoneytokenKind = (typeof HONEYTOKEN_KINDS)[number];
export type Detection = 'fake_auth' | 'file_read' | 'db_audit' | 'decoy_endpoint' | 'decoy_form';

export interface HoneytokenPlacement {
  kind: HoneytokenKind;
  /** 匿名の配置 ID（小文字英数字と -）。事件の証拠にはこれだけが出る。 */
  placementId: string;
  detections: readonly Detection[];
  validFrom: number;
  validUntil: number;
  /** file_read 用：decoy ファイルのパスの SHA-256 ではなく HMAC（パスそのものは持たない）。 */
  pathHash?: string;
  /** db_audit 用：decoy 専用 relation。 */
  relation?: string;
}

/** 7 種それぞれの配置場所と検知経路（承認済みの配備で実体化する）。 */
export const PLACEMENT_TEMPLATES: Record<HoneytokenKind, { location: string; detections: readonly Detection[] }> = {
  fake_env_key: { location: 'config / env / container image: fake key only', detections: ['fake_auth', 'file_read'] },
  decoy_admin_row: { location: 'main DB decoy relation: fake admin without operators/passkeys/sessions', detections: ['db_audit'] },
  decoy_student_row: { location: 'PII DB decoy relation: fully synthetic student, outside submission/grant/mail/7-day-deletion paths', detections: ['db_audit'] },
  fake_repo_key: { location: 'deep repo working copy / backup decoy object: fake API key generated at deploy', detections: ['fake_auth'] },
  decoy_internal_url: { location: 'isolated decoy endpoint on the main origin', detections: ['decoy_endpoint'] },
  decoy_dotenv: { location: 'main domain GET /.env: fake key only, no-store', detections: ['decoy_endpoint', 'fake_auth'] },
  decoy_admin_login: { location: 'main domain /admin/login: fake form, POST input fires', detections: ['decoy_form'] },
};

const KIND_CODE: Record<HoneytokenKind, string> = { fake_env_key: 'e', decoy_admin_row: 'a', decoy_student_row: 's', fake_repo_key: 'r', decoy_internal_url: 'u', decoy_dotenv: 'd', decoy_admin_login: 'l' };
/** 配備時にだけ呼ぶ。乱数は注入できる（テスト）。 */
export function generateHoneytokenValue(kind: HoneytokenKind, rand: (n: number) => Buffer = randomBytes): string {
  return `ht${KIND_CODE[kind]}_${rand(24).toString('base64url')}`;
}

export const PLACEMENT_ID_RE = /^[a-z0-9][a-z0-9-]{5,39}$/;
const MAX_PRESENTED = 512;

export class HoneytokenRegistry {
  private byDigest = new Map<string, HoneytokenPlacement>();
  private byId = new Map<string, HoneytokenPlacement>();
  constructor(private key: Buffer, private now: () => number = Date.now) {
    if (key.length < 32) throw new Error('honeytoken key too short');
  }
  digest(value: string): string { return createHmac('sha256', this.key).update(`honeytoken:${value}`).digest('hex'); }
  hashPath(path: string): string { return createHmac('sha256', this.key).update(`honeypath:${path}`).digest('hex'); }
  register(p: HoneytokenPlacement, value?: string): void {
    if (!HONEYTOKEN_KINDS.includes(p.kind) || !PLACEMENT_ID_RE.test(p.placementId) || !(p.validUntil > p.validFrom)) throw new Error('invalid_placement');
    if (this.byId.has(p.placementId)) throw new Error('duplicate_placement');
    this.byId.set(p.placementId, p);
    if (value !== undefined) this.byDigest.set(this.digest(value), p);
  }
  private live(p: HoneytokenPlacement | undefined): HoneytokenPlacement | null {
    const t = this.now();
    return p && p.validFrom <= t && t < p.validUntil ? p : null;
  }
  /** 提示された値が登録済みの罠か。未登録・期限外は null（通常の失敗として扱い、発火しない）。 */
  lookup(presented: string | undefined | null): HoneytokenPlacement | null {
    if (!presented || presented.length > MAX_PRESENTED) return null;
    const d = this.digest(presented);
    for (const [k, p] of this.byDigest) {
      if (k.length === d.length && timingSafeEqual(Buffer.from(k), Buffer.from(d))) return this.live(p);
    }
    return null;
  }
  firstOfKind(kind: HoneytokenKind): HoneytokenPlacement | null {
    for (const p of this.byId.values()) if (p.kind === kind && this.live(p)) return p;
    return null;
  }
  placement(placementId: string): HoneytokenPlacement | null { return this.live(this.byId.get(placementId)); }
  byRelation(relation: string): HoneytokenPlacement | null {
    for (const p of this.byId.values()) if (p.relation === relation) return this.live(p);
    return null;
  }
  byPathHash(pathHash: string): HoneytokenPlacement | null {
    for (const p of this.byId.values()) if (p.pathHash === pathHash) return this.live(p);
    return null;
  }
  /** 7 種すべてに有効な配置があるか（doctor / status 用）。 */
  coverage(): { kind: HoneytokenKind; placed: boolean }[] {
    return HONEYTOKEN_KINDS.map((kind) => ({ kind, placed: [...this.byId.values()].some((p) => p.kind === kind && this.live(p) !== null) }));
  }
}

/** ⑥ の /.env 本文。偽鍵だけ（実際の設定名・URL・資格情報は一つも含まない）。 */
export const decoyDotenvBody = (value: string): string => `# generated\nSERVICE_API_KEY=${value}\n`;

/** ③ の合成学生。実在しうる氏名・生年月日・学校・メールを含まない（.invalid、予約済み表記）。 */
export function syntheticStudent(placementId: string): { displayName: string; email: string; school: string; birthDate: string; note: string } {
  return { displayName: `Decoy ${placementId}`, email: `${placementId}@decoy.invalid`, school: 'Decoy Academy (synthetic)', birthDate: '1900-01-01', note: 'synthetic honeytoken row' };
}
