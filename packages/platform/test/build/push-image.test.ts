import { describe, expect, it } from 'vitest';
import { pushImage } from '../../src/build/build.js';

describe('pushImage', () => {
  it('refuses registry names that are not plain host[:port][/path] before running docker', async () => {
    for (const bad of ['', 'Localhost:5050', 'localhost:5050/../x', 'localhost:5050 --rm', 'http://localhost:5050', 'a;b']) {
      expect(await pushImage('ys/x:y', bad, '/nonexistent-docker')).toEqual({ ok: false, log: `invalid registry: ${bad}` });
    }
  });
});

describe('pushImage registry names', () => {
  it('accepts host:port and a path', async () => {
    // Valid names get past the check and reach docker (missing here), so the failure is from spawning it.
    for (const ok of ['localhost:5050', 'registry.example.com/team-a', 'k3d-ys-registry.localhost:5000/ys']) {
      const r = await pushImage('ys/x:y', ok, '/nonexistent-docker');
      expect(r.ok === false && r.log.startsWith('invalid registry')).toBe(false);
    }
  });
});
