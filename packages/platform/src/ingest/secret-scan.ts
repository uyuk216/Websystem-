export type Finding = { path: string; line: number; rule: string };

const RULES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/ },
  { rule: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { rule: 'stripe_key', re: /sk_(live|test)_[A-Za-z0-9]{16,}/ },
  { rule: 'slack_token', re: /xox[baprs]-/ },
  { rule: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'google_api_key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { rule: 'env_secret', re: /(SECRET|TOKEN|PASSWORD|API_KEY)\s*=\s*\S{8,}/ },
];

export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** Returns path/line/rule only; the matched value is never returned. */
export function scanSecrets(path: string, content: Buffer): Finding[] {
  if (content.length > MAX_SCAN_BYTES || content.includes(0)) return [];
  const findings: Finding[] = [];
  const lines = content.toString('utf8').split(/\r\n|\n|\r/);
  lines.forEach((text, i) => {
    for (const { rule, re } of RULES) {
      if (re.test(text)) findings.push({ path, line: i + 1, rule });
    }
  });
  return findings;
}
