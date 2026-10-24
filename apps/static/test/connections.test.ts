import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'api/db';
import { ConnectionRegistry } from '../src/connections.js';

const state = vi.hoisted(() => ({ apps: new Set<string>(), ips: new Set<string>() }));
vi.mock('api/security-gate', () => ({
  blockedAppIds: async () => new Set(state.apps),
  blockedIpHashes: async () => new Set(state.ips),
}));
afterEach(() => { vi.useRealTimers(); state.apps.clear(); state.ips.clear(); });

describe('connection reconciliation deadline', () => {
  it('closes connections on two edges within one second even without notifications', async () => {
    vi.useFakeTimers();
    const first = new ConnectionRegistry(); const second = new ConnectionRegistry();
    const closeA = vi.fn(); const closeB = vi.fn(); const unaffected = vi.fn();
    first.add({ appId: 'blocked', ipHash: null, close: closeA });
    second.add({ appId: 'other', ipHash: 'blocked-ip', close: closeB });
    second.add({ appId: 'fine', ipHash: null, close: unaffected });
    const stops = [first.start({} as Db), second.start({} as Db)];
    try {
      state.apps.add('blocked'); state.ips.add('blocked-ip');
      await vi.advanceTimersByTimeAsync(999);
      expect(closeA).not.toHaveBeenCalled(); expect(closeB).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(closeA).toHaveBeenCalledOnce(); expect(closeB).toHaveBeenCalledOnce();
      expect(unaffected).not.toHaveBeenCalled();
    } finally { stops.forEach((stop) => stop()); }
  });
  it('rejects intervals exceeding the one second contract', () => {
    const registry = new ConnectionRegistry();
    for (const interval of [0, -1, 1001, Infinity, NaN]) expect(() => registry.start({} as Db, interval)).toThrow(RangeError);
  });
});
