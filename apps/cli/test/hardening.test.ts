import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles } from '../src/archive.js';
import { saveConfig, configPath } from '../src/config.js';
import { checkApiUrl } from '../src/index.js';

describe('hardening', () => {
  it('aborts when .gitignore cannot be read (non-ENOENT)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ys-cli-'));
    mkdirSync(join(d, '.gitignore')); // a directory: read fails with EISDIR
    await expect(collectFiles(d)).rejects.toThrow();
  });

  it('requires --insecure for non-local http API URLs', () => {
    expect(() => checkApiUrl('http://localhost:3001', false)).not.toThrow();
    expect(() => checkApiUrl('http://127.0.0.1:3001', false)).not.toThrow();
    expect(() => checkApiUrl('https://api.example.com', false)).not.toThrow();
    expect(() => checkApiUrl('http://api.example.com', false)).toThrow(/--insecure/);
    expect(() => checkApiUrl('http://api.example.com', true)).not.toThrow();
  });

  it('writes config via rename, leaving no temp file, dir 0700', () => {
    const d = mkdtempSync(join(tmpdir(), 'ys-cli-'));
    const env = { XDG_CONFIG_HOME: d };
    saveConfig(env, { token: 'ysk_a' });
    saveConfig(env, { token: 'ysk_b' });
    expect(readdirSync(join(d, 'yourservice'))).toEqual(['config.json']);
    expect(statSync(join(d, 'yourservice')).mode & 0o777).toBe(0o700);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  });
});
