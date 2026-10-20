/**
 * セキュリティヘッダー（このアプリの "middleware"）。学生証の提出ページに載せるのは、SRI つきの自前スクリプト 1 本だけ。
 * script-src はそのスクリプトのハッシュだけを許可し（'self' も 'unsafe-inline' も無し）、サードパーティは一切読み込まない。
 * Next.js の起動用インラインスクリプトはハッシュ固定にできないため、フレームワークを使わずに作っている。
 */
export function contentSecurityPolicy(scriptIntegrity: string): string {
  return [
    "default-src 'none'",
    `script-src '${scriptIntegrity}'`,
    "style-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(scriptIntegrity: string): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(scriptIntegrity),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Frame-Options': 'DENY',
  };
}
