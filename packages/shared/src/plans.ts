/** Static-site limits (Phase 2 defaults). The single place these numbers live. */
export const STATIC_LIMITS = {
  storageBytes: 200 * 1024 ** 2,
  fileBytes: 25 * 1024 ** 2,
  monthlyTransferBytes: 10 * 1024 ** 3,
  sitesPerOwner: 1,
} as const;

/** Dynamic-app limits (Phase 3 defaults). Plan-based selection arrives in Phase 5. */
/** User databases (phase 4): one per dynamic app. */
export const DATABASE_LIMITS = {
  sizeBytes: 256 * 1024 ** 2,
  connections: 10,
  memoryMb: 256,
  /** Share of sizeBytes: notify at warn, read-only at full, refuse connections at hard. */
  warnRatio: 0.8,
  hardRatio: 1.1,
  backupIntervalMinutes: 60,
  backupRetentionDays: 7,
} as const;

export const DYNAMIC_LIMITS = {
  memoryMb: 512,
  cpu: 0.5,
  pids: 256,
  appsPerOwner: 1,
  monthlyHours: 240,
  fiscalYearHours: 2000,
  sleepAfterMinutes: 15,
  buildTimeoutMinutes: 15,
  imageBytes: 1024 ** 3,
} as const;

/**
 * Starter（Pro 相当）の仮の値。Pro の中身はフェーズ 7 で決まるので、いまは Student と同じ値 + 動的アプリ 2 つ。
 * TODO(フェーズ 7): Pro の仕様が決まったらここを更新する。
 */
export const STARTER_LIMITS = { ...DYNAMIC_LIMITS, appsPerOwner: 2 } as const;

/** 付与がない（「なし」プラン）ときの動的アプリの上限。アプリは動かせない。 */
export const NO_PLAN_DYNAMIC_LIMITS = {
  memoryMb: 0, cpu: 0, pids: 0, appsPerOwner: 0, monthlyHours: 0, fiscalYearHours: 0,
  sleepAfterMinutes: DYNAMIC_LIMITS.sleepAfterMinutes, buildTimeoutMinutes: DYNAMIC_LIMITS.buildTimeoutMinutes, imageBytes: 0,
} as const;

export type PlanKind = 'none' | 'student' | 'starter';

export interface Entitlements {
  plan: PlanKind;
  static: { storageBytes: number; fileBytes: number; monthlyTransferBytes: number; sitesPerOwner: number };
  dynamic: {
    memoryMb: number; cpu: number; pids: number; appsPerOwner: number; monthlyHours: number; fiscalYearHours: number;
    /** null = スリープしない（イベントブースト中）。 */
    sleepAfterMinutes: number | null; buildTimeoutMinutes: number; imageBytes: number;
  };
  database: { sizeBytes: number; connections: number; memoryMb: number };
  /** 付与の終わり（Student / Starter のうち有効なものの最も遅い終わり）と停止日。「なし」は null。 */
  endsAt: Date | null;
  suspendOn: Date | null;
}

/** イベントブーストの上げ幅（`grants.params`）。期間中だけ上乗せする。 */
export interface BoostParams {
  extraTransferBytes?: number;
  extraMemoryMb?: number;
  sleepOff?: boolean;
}

/** `platform_settings` で上書きできる数字のキー（`limits.<区分>.<名前>`）。これ以外のキーは上限として扱わない。 */
export const LIMIT_SETTING_KEYS = [
  'limits.static.storageBytes', 'limits.static.fileBytes', 'limits.static.monthlyTransferBytes', 'limits.static.sitesPerOwner',
  'limits.dynamic.memoryMb', 'limits.dynamic.cpu', 'limits.dynamic.pids', 'limits.dynamic.appsPerOwner', 'limits.dynamic.monthlyHours',
  'limits.dynamic.fiscalYearHours', 'limits.dynamic.sleepAfterMinutes', 'limits.dynamic.buildTimeoutMinutes', 'limits.dynamic.imageBytes',
  'limits.database.sizeBytes', 'limits.database.connections', 'limits.database.memoryMb',
] as const;
export type LimitOverrides = Partial<Record<(typeof LIMIT_SETTING_KEYS)[number], number>>;

export const isLimitSettingKey = (key: string): key is (typeof LIMIT_SETTING_KEYS)[number] => (LIMIT_SETTING_KEYS as readonly string[]).includes(key);
/** 上限の値として妥当か（0 以上の有限の数）。 */
export const validLimitValue = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * 有効な付与の種類から、いまのプランの上限を組み立てる（DB を読まない純粋関数）。
 * 設定の上書きは Student / Starter の動的アプリの値と、全プラン共通の静的サイトの値にだけ効く（「なし」の動的は 0 のまま）。
 */
export function buildEntitlements(input: {
  student: boolean; starter: boolean; boosts: BoostParams[]; overrides?: LimitOverrides; endsAt?: Date | null; suspendOn?: Date | null;
}): Entitlements {
  const o = input.overrides ?? {};
  const pick = (key: (typeof LIMIT_SETTING_KEYS)[number], base: number): number => (validLimitValue(o[key]) ? (o[key] as number) : base);
  const plan: PlanKind = input.starter ? 'starter' : input.student ? 'student' : 'none';
  const dyn = plan === 'starter' ? STARTER_LIMITS : plan === 'student' ? DYNAMIC_LIMITS : NO_PLAN_DYNAMIC_LIMITS;
  const paid = plan !== 'none';
  const sum = (f: (b: BoostParams) => number | undefined): number => input.boosts.reduce((a, b) => a + (f(b) ?? 0), 0);
  const e: Entitlements = {
    plan,
    static: {
      storageBytes: pick('limits.static.storageBytes', STATIC_LIMITS.storageBytes),
      fileBytes: pick('limits.static.fileBytes', STATIC_LIMITS.fileBytes),
      monthlyTransferBytes: pick('limits.static.monthlyTransferBytes', STATIC_LIMITS.monthlyTransferBytes) + sum((b) => b.extraTransferBytes),
      sitesPerOwner: pick('limits.static.sitesPerOwner', STATIC_LIMITS.sitesPerOwner),
    },
    dynamic: {
      memoryMb: paid ? pick('limits.dynamic.memoryMb', dyn.memoryMb) + sum((b) => b.extraMemoryMb) : 0,
      cpu: paid ? pick('limits.dynamic.cpu', dyn.cpu) : 0,
      pids: paid ? pick('limits.dynamic.pids', dyn.pids) : 0,
      appsPerOwner: paid ? pick('limits.dynamic.appsPerOwner', dyn.appsPerOwner) : 0,
      monthlyHours: paid ? pick('limits.dynamic.monthlyHours', dyn.monthlyHours) : 0,
      fiscalYearHours: paid ? pick('limits.dynamic.fiscalYearHours', dyn.fiscalYearHours) : 0,
      sleepAfterMinutes: paid && input.boosts.some((b) => b.sleepOff) ? null : pick('limits.dynamic.sleepAfterMinutes', dyn.sleepAfterMinutes),
      buildTimeoutMinutes: pick('limits.dynamic.buildTimeoutMinutes', dyn.buildTimeoutMinutes),
      imageBytes: paid ? pick('limits.dynamic.imageBytes', dyn.imageBytes) : 0,
    },
    database: {
      sizeBytes: paid ? pick('limits.database.sizeBytes', DATABASE_LIMITS.sizeBytes) : 0,
      connections: paid ? pick('limits.database.connections', DATABASE_LIMITS.connections) : 0,
      memoryMb: paid ? pick('limits.database.memoryMb', DATABASE_LIMITS.memoryMb) : 0,
    },
    endsAt: paid ? (input.endsAt ?? null) : null,
    suspendOn: paid ? (input.suspendOn ?? null) : null,
  };
  return e;
}
