import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { clearConfig, loadConfig, saveConfig } from './config.js';
import { deploy, listApps } from './commands.js';

const HELP = `Usage: yourservice <command>

Commands:
  login                      Save an API token (paste it when prompted)
  apps                       List your apps
  deploy [dir] --app <name>  Zip a directory (honoring .gitignore) and deploy it
  logout                     Remove the saved token

Environment:
  YOURSERVICE_API            API base URL (default http://localhost:3001)
  --insecure                 Allow a non-local http:// API URL
`;

/** Reads a line without echoing it (the token is a credential). */
async function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  let muted = false;
  const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  muted = true;
  try { return await rl.question(''); } finally { rl.close(); if (process.stdin.isTTY) process.stdout.write('\n'); }
}

/** A bearer token must not cross the network in cleartext unless the user insists. */
export function checkApiUrl(api: string, insecure: boolean): void {
  const u = new URL(api);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && !local) {
    if (!insecure) throw new Error(`Refusing to send your token over plain http:// to ${u.hostname}. Use https, or pass --insecure.`);
    console.error(`Warning: sending your token over plain http:// to ${u.hostname}.`);
  }
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const out = { log: (s: string) => console.log(s) };
  const api = env.YOURSERVICE_API || 'http://localhost:3001';
  const insecure = argv.includes('--insecure');
  const [cmd, ...rest] = argv.filter((a) => a !== '--insecure');
  try {
    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return 0; }
    if (cmd === 'login') {
      const token = (await promptHidden('API token: ')).trim();
      if (!token.startsWith('ysk_')) throw new Error('That does not look like an API token (expected ysk_...).');
      saveConfig(env, { token });
      out.log('Saved.');
      return 0;
    }
    if (cmd === 'logout') { clearConfig(env); out.log('Logged out.'); return 0; }
    const cfg = loadConfig(env);
    if (!cfg) throw new Error('Not logged in. Run `yourservice login`.');
    if (cmd === 'apps' || cmd === 'deploy') checkApiUrl(api, insecure);
    if (cmd === 'apps') {
      for (const a of await listApps({ api, token: cfg.token })) out.log(a.name);
      return 0;
    }
    if (cmd === 'deploy') {
      const { values, positionals } = parseArgs({ args: rest, options: { app: { type: 'string' } }, allowPositionals: true });
      if (!values.app) throw new Error('Missing --app <name>.');
      await deploy({ api, token: cfg.token, dir: positionals[0] ?? '.', app: values.app, out });
      return 0;
    }
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    return 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
