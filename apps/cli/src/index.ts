import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { clearConfig, loadConfig, saveConfig } from './config.js';
import { deploy, envList, envSet, envUnset, listApps, appLogs } from './commands.js';

const HELP = `Usage: yourservice <command>

Commands:
  login                      Save an API token (paste it when prompted)
  apps                       List your apps
  deploy [dir] --app <name>  Zip a directory (honoring .gitignore) and deploy it
  env list --app <name>      List variable names (values are never shown)
  env set NAME=VALUE --app <name>   Set a variable; \`env set NAME --stdin\` reads the value from stdin
  env unset NAME --app <name>       Remove a variable (restart the app to apply changes)
  logs --app <name> [--tail N]      Show the latest app output (default 100 lines, max 1000)
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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
    if (cmd === 'apps' || cmd === 'deploy' || cmd === 'env' || cmd === 'logs') checkApiUrl(api, insecure);
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
    if (cmd === 'logs') {
      const { values } = parseArgs({ args: rest, options: { app: { type: 'string' }, tail: { type: 'string' } } });
      if (!values.app) throw new Error('Missing --app <name>.');
      const tail = values.tail === undefined ? 100 : Number(values.tail);
      if (!Number.isInteger(tail) || tail < 1 || tail > 1000) throw new Error('--tail must be an integer from 1 to 1000.');
      for (const l of await appLogs({ api, token: cfg.token, app: values.app, tail })) out.log(l);
      return 0;
    }
    if (cmd === 'env') {
      const { values, positionals } = parseArgs({ args: rest, options: { app: { type: 'string' }, stdin: { type: 'boolean' } }, allowPositionals: true });
      if (!values.app) throw new Error('Missing --app <name>.');
      const [sub, arg] = positionals;
      const b = { api, token: cfg.token, app: values.app };
      if (sub === 'list') {
        for (const v of await envList(b)) out.log(v.name);
        return 0;
      }
      if (sub === 'unset') {
        if (!arg) throw new Error('Usage: env unset NAME --app <name>');
        await envUnset({ ...b, name: arg });
        out.log(`Unset ${arg}. Restart the app to apply.`);
        return 0;
      }
      if (sub === 'set') {
        if (!arg) throw new Error('Usage: env set NAME=VALUE --app <name>  (or env set NAME --stdin)');
        let name = arg;
        let value: string;
        if (values.stdin) {
          if (arg.includes('=')) throw new Error('With --stdin pass only NAME; the value is read from stdin.');
          value = (await readStdin()).replace(/\r?\n$/, '');
        } else {
          const i = arg.indexOf('=');
          if (i < 1) throw new Error('Expected NAME=VALUE (or use --stdin).');
          name = arg.slice(0, i);
          value = arg.slice(i + 1);
        }
        await envSet({ ...b, name, value });
        out.log(`Set ${name}. Restart the app to apply.`);
        return 0;
      }
      throw new Error('Usage: env list|set|unset --app <name>');
    }
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    return 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
