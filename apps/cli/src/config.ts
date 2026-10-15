import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Config {
  token: string;
}
type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'yourservice', 'config.json');
}

export function loadConfig(env: Env = process.env): Config | null {
  try {
    const v = JSON.parse(readFileSync(configPath(env), 'utf8')) as Partial<Config>;
    return typeof v.token === 'string' && v.token ? { token: v.token } : null;
  } catch {
    return null;
  }
}

/** Written 0600 via a temp file + rename (never a world-readable window); the directory is 0700. */
export function saveConfig(env: Env, cfg: Config): void {
  const p = configPath(env);
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mode is ignored when the directory already existed
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

export function clearConfig(env: Env = process.env): void {
  rmSync(configPath(env), { force: true });
}
