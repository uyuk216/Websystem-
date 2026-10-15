export const TEAM_MAX_MEMBERS = 10;

export type TeamRole = 'owner' | 'admin' | 'member';
export type TeamAction = 'invite' | 'remove' | 'changeRole' | 'deleteTeam' | 'transferOwner' | 'deploy';

const ALLOWED: Record<TeamRole, readonly TeamAction[]> = {
  owner: ['invite', 'remove', 'changeRole', 'deleteTeam', 'transferOwner', 'deploy'],
  admin: ['invite', 'remove', 'changeRole', 'deploy'],
  member: ['deploy'],
};

/**
 * Role-level permission. Target-specific limits (admins may remove only plain members, may switch
 * only member<->admin, and nobody acts on the owner) are enforced where the target is known.
 */
export function can(role: TeamRole, action: TeamAction): boolean {
  return ALLOWED[role].includes(action);
}
