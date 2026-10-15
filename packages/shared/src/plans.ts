/** Static-site limits (Phase 2 defaults). The single place these numbers live. */
export const STATIC_LIMITS = {
  storageBytes: 200 * 1024 ** 2,
  fileBytes: 25 * 1024 ** 2,
  monthlyTransferBytes: 10 * 1024 ** 3,
  sitesPerOwner: 1,
} as const;

/** Dynamic-app limits (Phase 3 defaults). Plan-based selection arrives in Phase 5. */
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
