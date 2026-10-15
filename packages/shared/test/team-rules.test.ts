import { describe, expect, it } from 'vitest';
import { TEAM_MAX_MEMBERS, can } from '../src/index.js';

describe('team rules', () => {
  it('limits and matrix', () => {
    expect(TEAM_MAX_MEMBERS).toBe(10);
    expect(can('owner', 'deleteTeam')).toBe(true);
    expect(can('owner', 'transferOwner')).toBe(true);
    for (const a of ['invite', 'remove', 'changeRole', 'deploy'] as const) expect(can('admin', a)).toBe(true);
    expect(can('admin', 'deleteTeam')).toBe(false);
    expect(can('admin', 'transferOwner')).toBe(false);
    expect(can('member', 'deploy')).toBe(true);
    for (const a of ['invite', 'remove', 'changeRole', 'deleteTeam', 'transferOwner'] as const) expect(can('member', a)).toBe(false);
  });
});
