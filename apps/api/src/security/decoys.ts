import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { decoyDotenvBody, type HoneytokenRegistry } from 'platform';
import type { Db } from '../db/client.js';
import { fireHoneytoken } from './honeytokens.js';
import { hashIp } from './ip.js';
import { buildSignal } from './signals.js';
import { handleSecuritySignal } from './incidents.js';
import { isScanPath, type ScanDetector } from './scan-detector.js';

export interface DecoyConfig {
  registry: HoneytokenRegistry;
  /** 本体ドメインの Host（ポート抜き）。これ以外（利用者サイトのドメイン等）には罠を出さない。 */
  publicHosts: string[];
  /** ⑥ の /.env に載せる偽鍵。配備時に生成した値（未設定なら /.env の罠は出さない＝404）。 */
  dotenvValue?: string;
  scan?: ScanDetector;
}
const FORM = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in</title><form method="post" action="/admin/login"><input name="u" autocomplete="off"><input name="p" type="password" autocomplete="off"><button>Sign in</button></form></html>';

/**
 * 本体の公開ドメイン限定の罠。本物の管理 API は mount しない。利用者サイト（別ドメイン・別サーバー）には一切出ない。
 * /.env は偽鍵だけ（no-store）、/admin/login の GET は表示だけで発火せず POST の入力の存在で発火（本文は読み捨てる）、
 * /decoy/auth は偽 credential の検証口、/_int/:id は偽の内部 URL。探索パスは時間窓で集約し、探索元の IP だけを遮断する。
 */
export function mountDecoys(app: Hono, deps: { db: Db; hashKey: Buffer; clientIp: (c: Context) => string; decoys: DecoyConfig }): void {
  const { decoys, db, hashKey } = deps;
  const hosts = new Set(decoys.publicHosts.map((h) => h.toLowerCase()));
  const onPublicHost = (c: Context): boolean => hosts.has((c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, ''));
  const fire = (c: Context, kind: Parameters<HoneytokenRegistry['firstOfKind']>[0], via: 'decoy_endpoint' | 'decoy_form' | 'fake_auth') => {
    const p = decoys.registry.firstOfKind(kind);
    if (!p) return Promise.resolve(null);
    const ip = deps.clientIp(c);
    return fireHoneytoken({ db, hashKey }, p, hashIp(ip, hashKey) ? ip : null, via);
  };
  const noStore = (c: Context) => { c.header('Cache-Control', 'no-store'); c.header('X-Robots-Tag', 'noindex'); };

  // 探索の集約：404 になった探索パスを送信元ごとに数え、しきい値で探索元の IP だけを遮断する（被害側アプリは止めない）。
  if (decoys.scan) {
    const scan = decoys.scan;
    app.use('*', async (c, next) => {
      await next();
      if (!onPublicHost(c) || !isScanPath(c.req.path)) return;
      if (c.res.status !== 404 && c.res.status !== 401 && c.res.status !== 200) return;
      const ipHash = hashIp(deps.clientIp(c), hashKey);
      if (!ipHash) return; // 取得不能な送信元は共有の unknown を作らない
      const r = scan.record(ipHash, c.req.path);
      if (!r.fire) return;
      await handleSecuritySignal(db, buildSignal({
        source: 'honeytoken', sourceEventId: `scan:${ipHash.slice(0, 24)}:${r.windowStart}`, ruleVersion: '1', occurredAt: new Date(),
        severity: 'medium', target: { kind: 'ip', ipHash }, reasonCode: 'scan.probe', evidence: { category: 'scan', count: 1 },
      })).catch((e) => console.error('scan signal failed', e));
    });
  }

  app.get('/.env', (c) => {
    if (!onPublicHost(c) || !decoys.dotenvValue) return c.notFound();
    noStore(c);
    return c.body(decoyDotenvBody(decoys.dotenvValue), 200, { 'content-type': 'text/plain; charset=utf-8' });
  });
  app.get('/admin/login', (c) => {
    if (!onPublicHost(c) || !decoys.registry.firstOfKind('decoy_admin_login')) return c.notFound();
    noStore(c);
    return c.html(FORM); // GET だけでは「入力した」とは見なさない
  });
  app.post('/admin/login', bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: 'invalid' }, 413) }), async (c) => {
    if (!onPublicHost(c) || !decoys.registry.firstOfKind('decoy_admin_login')) return c.notFound();
    const text = await c.req.text().catch(() => ''); // 読み捨てる。保存も記録もしない
    if (text.length > 0) await fire(c, 'decoy_admin_login', 'decoy_form');
    noStore(c);
    return c.json({ error: 'invalid_credentials' }, 401);
  });
  app.post('/decoy/auth', async (c) => {
    noStore(c);
    if (!onPublicHost(c)) return c.notFound();
    const bearer = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim();
    const p = decoys.registry.lookup(bearer ?? c.req.header('x-api-key'));
    if (p) {
      const ip = deps.clientIp(c);
      await fireHoneytoken({ db, hashKey }, p, hashIp(ip, hashKey) ? ip : null, 'fake_auth');
    }
    return c.json({ error: 'invalid_credentials' }, 401); // 登録済みでも未登録でも同じ応答
  });
  app.get('/_int/:id', async (c) => {
    if (!onPublicHost(c)) return c.notFound();
    const p = decoys.registry.placement(c.req.param('id'));
    if (!p || p.kind !== 'decoy_internal_url') return c.notFound();
    const ip = deps.clientIp(c);
    await fireHoneytoken({ db, hashKey }, p, hashIp(ip, hashKey) ? ip : null, 'decoy_endpoint');
    noStore(c);
    return c.json({ error: 'forbidden' }, 403);
  });
}

/** 配備前のレジストリ状態（承認前は空）。doctor / status が「not installed」と 7 種の配置状況を出す。 */
export function honeytokenStatus(registry: HoneytokenRegistry): { installed: boolean; placed: number; missing: string[] } {
  const cov = registry.coverage();
  return { installed: cov.some((c) => c.placed), placed: cov.filter((c) => c.placed).length, missing: cov.filter((c) => !c.placed).map((c) => c.kind) };
}
