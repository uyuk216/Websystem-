import { describe, expect, it } from 'vitest';
import { detectStack } from '../../src/build/detect.js';

const stack = (files: Record<string, string>) => detectStack(Object.keys(files), (p) => files[p] ?? null);

describe('detectStack', () => {
  it('prefers a Dockerfile', () => {
    expect(stack({ Dockerfile: 'FROM x', 'package.json': '{}', 'index.php': '' })).toEqual({ kind: 'dockerfile' });
  });
  it('node with lockfile uses npm ci, without uses npm install', () => {
    const pkg = JSON.stringify({ scripts: { start: 'node server.js' } });
    const a = stack({ 'package.json': pkg, 'package-lock.json': '{}' });
    const b = stack({ 'package.json': pkg });
    expect(a).toMatchObject({ kind: 'node' });
    expect((a as { dockerfile: string }).dockerfile).toContain('npm ci --omit=dev');
    expect((b as { dockerfile: string }).dockerfile).toContain('npm install --omit=dev');
    expect((a as { dockerfile: string }).dockerfile).toMatch(/FROM node:22-alpine/);
    expect((a as { dockerfile: string }).dockerfile).toContain('CMD ["npm","start"]');
    expect((a as { dockerfile: string }).dockerfile).toMatch(/^USER node$/m);
  });
  it('node without start script or with broken package.json is unknown', () => {
    expect(stack({ 'package.json': '{"scripts":{}}' })).toEqual({ error: 'unknown_stack' });
    expect(stack({ 'package.json': '{' })).toEqual({ error: 'unknown_stack' });
  });
  it('python picks gunicorn for flask and uvicorn for fastapi', () => {
    const f = stack({ 'requirements.txt': 'flask==3.0\n', 'app.py': '' }) as { kind: string; dockerfile: string };
    expect(f.kind).toBe('python');
    expect(f.dockerfile).toContain('gunicorn --bind 0.0.0.0:${PORT} app:app');
    expect(f.dockerfile).toContain('FROM python:3.12-alpine');
    expect(f.dockerfile).toMatch(/^USER app$/m);
    const u = stack({ 'requirements.txt': 'fastapi>=0.1\nuvicorn[standard]\n', 'main.py': '' }) as { dockerfile: string };
    expect(u.dockerfile).toContain('uvicorn main:app --host 0.0.0.0 --port ${PORT}');
  });
  it('python needs requirements.txt and app.py or main.py', () => {
    expect(stack({ 'requirements.txt': 'flask' })).toEqual({ error: 'unknown_stack' });
    expect(stack({ 'app.py': '' })).toEqual({ error: 'unknown_stack' });
  });
  it('php', () => {
    const p = stack({ 'index.php': '<?php' }) as { kind: string; dockerfile: string };
    expect(p.kind).toBe('php');
    expect(p.dockerfile).toContain('FROM php:8.3-apache');
    expect(p.dockerfile).toContain('Listen ${PORT}');
    expect(p.dockerfile).toContain('PORT=8080');
    expect(p.dockerfile).toMatch(/^USER www-data$/m);
  });
  it('unknown', () => {
    expect(stack({ 'readme.md': '' })).toEqual({ error: 'unknown_stack' });
  });
});
