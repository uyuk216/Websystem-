import { describe, expect, it } from 'vitest';
import { createNetworkReputation, disabledNetworkSource, NetworkDataStore, refreshNetworkData } from '../../src/index.js';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const dataset = (over: Record<string, unknown> = {}) => ({
  version: 'fx-1', fetchedAt: new Date(T0).toISOString(), maxAgeSeconds: 3600,
  ranges: { vpn: ['198.51.100.0/24', '2001:db8:1::/48'], proxy: ['203.0.113.0/25'], tor: ['192.0.2.0/24', '198.51.100.7'] },
  exceptions: { school: ['198.51.100.0/28'], relay: ['2001:db8:1:5::/64'], bot: [] },
  ...over,
});
const setup = (now = { t: T0 }) => { const store = new NetworkDataStore(() => now.t); return { now, store, rep: createNetworkReputation(store) }; };

describe('network reputation (artificial CIDRs only)', () => {
  it('is not installed and unknown until validated data is loaded', async () => {
    const { store, rep } = setup();
    expect(rep.installed).toBe(false);
    expect(await rep.check('198.51.100.99')).toEqual({ blocked: true, reason: 'unknown' });
    expect(store.status('observe')).toMatchObject({ installed: false, state: 'not_installed', dataVersion: null });
    expect(await refreshNetworkData(store, disabledNetworkSource)).toEqual({ ok: false, error: 'not_installed' });
  });

  it('classifies vpn / proxy / tor for IPv4 and IPv6, and mapped IPv6', async () => {
    const { store, rep } = setup(); expect(store.update(dataset())).toMatchObject({ ok: true });
    expect(await rep.check('198.51.100.99')).toEqual({ blocked: true, reason: 'vpn' });
    expect(await rep.check('::ffff:198.51.100.99')).toEqual({ blocked: true, reason: 'vpn' });
    expect(await rep.check('[2001:db8:1:9::1]')).toEqual({ blocked: true, reason: 'vpn' });
    expect(await rep.check('203.0.113.9')).toEqual({ blocked: true, reason: 'proxy' });
    expect(await rep.check('192.0.2.50')).toEqual({ blocked: true, reason: 'tor' });
    expect(await rep.check('198.18.0.1')).toEqual({ blocked: false });
    expect(await rep.check('2001:db8:ffff::1')).toEqual({ blocked: false });
  });

  it('applies school / Private Relay exceptions before vpn and tor (including tor overlap)', async () => {
    const { store, rep } = setup(); store.update(dataset({ exceptions: { school: ['198.51.100.0/28', '192.0.2.0/28'], relay: ['2001:db8:1:5::/64'], bot: [] } }));
    expect(await rep.check('198.51.100.5')).toEqual({ blocked: false }); // school inside the vpn range
    expect(await rep.check('198.51.100.7')).toEqual({ blocked: false }); // school + tor listed
    expect(await rep.check('192.0.2.3')).toEqual({ blocked: false });
    expect(await rep.check('2001:db8:1:5::77')).toEqual({ blocked: false }); // relay inside vpn v6
    expect(await rep.check('198.51.100.200')).toEqual({ blocked: true, reason: 'vpn' });
  });

  it('treats broken IPs (and spoof-looking values) as unknown, never allowed', async () => {
    const { store, rep } = setup(); store.update(dataset());
    for (const bad of ['', 'unknown', '999.1.1.1', '1.2.3.4, 5.6.7.8', 'abc']) expect(await rep.check(bad)).toEqual({ blocked: true, reason: 'unknown' });
  });

  it('rejects bad datasets and keeps the previous version; stale rollback is refused', async () => {
    const { store, rep } = setup(); store.update(dataset());
    for (const [over, err] of [
      [{ ranges: { vpn: ['198.51.100.0/33'], proxy: [], tor: [] } }, 'invalid_cidr'],
      [{ ranges: { vpn: ['not-an-ip'], proxy: [], tor: [] } }, 'invalid_cidr'],
      [{ fetchedAt: new Date(T0 + 3_600_000).toISOString() }, 'invalid_fetched_at'],
      [{ maxAgeSeconds: 99 * 86400 }, 'invalid_max_age'],
      [{ fetchedAt: new Date(T0 - 7_200_000).toISOString() }, 'expired'],
      [{ version: 'bad version' }, 'invalid_version'],
    ] as const) expect(store.update(dataset(over as never))).toEqual({ ok: false, error: err });
    expect(store.update(dataset({ version: 'old', fetchedAt: new Date(T0 - 1000).toISOString() }))).toEqual({ ok: false, error: 'stale_rollback' });
    expect(store.status('enforce')).toMatchObject({ dataVersion: 'fx-1', state: 'ok' });
    expect(await rep.check('203.0.113.9')).toEqual({ blocked: true, reason: 'proxy' });
  });

  it('keeps using the previous version until it expires after a failed refresh, then reports unknown', async () => {
    const { now, store, rep } = setup(); store.update(dataset());
    const failing = { installed: true, fetch: async () => { throw new Error('down'); } };
    expect(await refreshNetworkData(store, failing)).toEqual({ ok: false, error: 'fetch_failed' });
    now.t = T0 + 3_599_000; expect(await rep.check('203.0.113.9')).toEqual({ blocked: true, reason: 'proxy' });
    now.t = T0 + 3_601_000;
    expect(await rep.check('203.0.113.9')).toEqual({ blocked: true, reason: 'unknown' });
    expect(await rep.check('198.18.0.1')).toEqual({ blocked: true, reason: 'unknown' });
    expect(store.status('enforce')).toMatchObject({ state: 'expired', installed: true });
    // a good refresh swaps atomically and recovers
    const ok = { installed: true, fetch: async () => dataset({ version: 'fx-2', fetchedAt: new Date(now.t).toISOString() }) };
    expect(await refreshNetworkData(store, ok)).toEqual({ ok: true, version: 'fx-2' });
    expect(await rep.check('198.18.0.1')).toEqual({ blocked: false });
  });
});

