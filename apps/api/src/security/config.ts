/**
 * IP のブロックを HMAC で引くための鍵（SECURITY_IP_KEY、base64 の 32 バイト）。生の IP は保存しない。
 * 本番（NODE_ENV=production）では必須。開発では固定の鍵で動く（警告を出す）。
 */
export function loadSecurityKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.SECURITY_IP_KEY;
  if (!raw) {
    if (env.NODE_ENV === 'production') throw new Error('Missing required env var: SECURITY_IP_KEY');
    console.warn('SECURITY_IP_KEY is not set: using the fixed development key');
    return Buffer.alloc(32, 7);
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('SECURITY_IP_KEY must be 32 bytes (base64)');
  return buf;
}
