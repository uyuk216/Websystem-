import { nodeDockerfile, phpDockerfile, pythonDockerfile } from './dockerfiles.js';

export type StackResult =
  | { kind: 'dockerfile' }
  | { kind: 'node' | 'python' | 'php'; dockerfile: string }
  | { error: 'unknown_stack' };

/**
 * Picks how to build a dynamic app. `files` are paths relative to the app root; `readFile` returns file
 * text (null when unreadable). A Dockerfile always wins.
 */
export function detectStack(files: string[], readFile: (path: string) => string | null): StackResult {
  const set = new Set(files);
  if (set.has('Dockerfile')) return { kind: 'dockerfile' };

  if (set.has('package.json')) {
    let start = false;
    try {
      const pkg = JSON.parse(readFile('package.json') ?? '') as { scripts?: Record<string, unknown> };
      start = typeof pkg.scripts?.start === 'string' && pkg.scripts.start.trim() !== '';
    } catch { /* invalid package.json: not a node app */ }
    if (start) return { kind: 'node', dockerfile: nodeDockerfile({ hasLockfile: set.has('package-lock.json') }) };
  }

  if (set.has('requirements.txt') && (set.has('app.py') || set.has('main.py'))) {
    const reqs = (readFile('requirements.txt') ?? '').toLowerCase();
    const names = reqs.split('\n').map((l) => l.split('#')[0]!.trim().split(/[<>=!~;[ ]/)[0]!);
    const asgi = names.some((n) => ['fastapi', 'uvicorn', 'starlette'].includes(n));
    const module = set.has('app.py') ? 'app' : 'main';
    return { kind: 'python', dockerfile: pythonDockerfile({ server: asgi ? 'uvicorn' : 'gunicorn', module }) };
  }

  if (set.has('index.php')) return { kind: 'php', dockerfile: phpDockerfile() };
  return { error: 'unknown_stack' };
}
