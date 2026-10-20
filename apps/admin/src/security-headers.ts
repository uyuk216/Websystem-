/**
 * 管理画面の殻（このアプリの "middleware"）。Next.js ではなく素の Node サーバーにしている（apps/upload と同じ理由：
 * インラインスクリプトを持たず、CSP を `script-src 'self'` だけにできる）。管理 API（/admin/*）は別プロセスで、
 * `tailscale serve` のパス指定で同じ tailnet のホスト名に載せる。ここでは API を中継しない
 * （中継すると API から見た接続元が tailnet のアドレスではなくなり、Tailscale 判定が成り立たない）。
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  // 検索エンジンに載せない。
  'X-Robots-Tag': 'noindex, nofollow',
};
