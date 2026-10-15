/** App names nobody may register: infrastructure, impersonation-prone brands and sensitive words. */
export const RESERVED_APP_NAMES: ReadonlySet<string> = new Set([
  'www', 'admin', 'administrator', 'api', 'login', 'logout', 'signin', 'signup', 'register', 'app', 'apps',
  'static', 'assets', 'cdn', 'mail', 'email', 'smtp', 'imap', 'ftp', 'ssh', 'status', 'docs', 'doc', 'help',
  'support', 'security', 'abuse', 'root', 'system', 'dashboard', 'console', 'account', 'accounts', 'billing',
  'pay', 'payment', 'payments', 'auth', 'oauth', 'sso', 'dev', 'staging', 'test', 'localhost', 'internal',
  'blog', 'news', 'about', 'terms', 'privacy', 'legal', 'contact', 'noreply', 'webhook', 'webhooks', 'git',
  'registry', 'metrics', 'grafana', 'minio', 'postgres', 'ns1', 'ns2',
  'paypal', 'google', 'apple', 'microsoft', 'github', 'gitlab', 'amazon', 'aws', 'line', 'stripe', 'facebook',
  'twitter', 'instagram', 'discord', 'slack', 'openai', 'anthropic', 'cloudflare', 'netflix', 'yahoo', 'rakuten',
]);
