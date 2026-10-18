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
