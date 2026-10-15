import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Written 0600 (the file holds a credential); the directory is 0700. */
export function saveConfig(env: Env, cfg: Config): void {
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg), { mode: 0o600 });
  chmodSync(p, 0o600); // mode is ignored when the file already existed
}

export function clearConfig(env: Env = process.env): void {
  rmSync(configPath(env), { force: true });
}
