import { describe, expect, it } from 'vitest';
import { decideNetworkAction, type NetworkAction, type NetworkVerdict } from '../src/index.js';

describe('operation permission table', () => {
  const verdicts: Record<string, NetworkVerdict> = { clean: { blocked: false }, vpn: { blocked: true, reason: 'vpn' }, tor: { blocked: true, reason: 'tor' }, unknown: { blocked: true, reason: 'unknown' } };
  const protectedActions: NetworkAction[] = ['signup', 'verification_start', 'id_upload', 'pro_purchase'];
  const open: NetworkAction[] = ['store_application', 'login', 'site_change', 'view', 'admin'];
  it('blocks known anonymizers with 403 and unknown with 503 only on protected actions', () => {
    for (const a of protectedActions) {
      expect(decideNetworkAction(a, verdicts.clean!)).toEqual({ allow: true });
      expect(decideNetworkAction(a, verdicts.vpn!)).toEqual({ allow: false, status: 403, reason: 'vpn' });
      expect(decideNetworkAction(a, verdicts.tor!)).toEqual({ allow: false, status: 403, reason: 'tor' });
      expect(decideNetworkAction(a, verdicts.unknown!)).toEqual({ allow: false, status: 503, reason: 'unknown' });
    }
  });
  it('never stops login, site changes, viewing, admin or store applications on VPN/unknown alone', () => {
    for (const a of open) for (const v of Object.values(verdicts)) expect(decideNetworkAction(a, v)).toEqual({ allow: true });
  });
});
