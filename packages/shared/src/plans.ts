/** Static-site limits (Phase 2 defaults). The single place these numbers live. */
export const STATIC_LIMITS = {
  storageBytes: 200 * 1024 ** 2,
  fileBytes: 25 * 1024 ** 2,
  monthlyTransferBytes: 10 * 1024 ** 3,
  sitesPerOwner: 1,
} as const;
