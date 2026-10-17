import { randomInt } from 'node:crypto';

const chars = (s: string): readonly string[] => [...s];

const UPPER = chars('ABCDEFGHJKLMNPQRSTUVWXYZ');
const LOWER = chars('abcdefghijkmnpqrstuvwxyz');
const DIGIT = chars('23456789');
// No "-" (the group separator) and nothing easily confused with another character.
const SYMBOL = chars('#$%&+=?@');

/** Groups a code must each contribute at least one character from. */
export const RECOVERY_GROUPS: readonly (readonly string[])[] = [UPPER, LOWER, DIGIT, SYMBOL];

export const RECOVERY_ALPHABET: readonly string[] = RECOVERY_GROUPS.flat();

const CODE_LENGTH = 32;
const GROUP_SIZE = 4;

const pick = (from: readonly string[]): string => from[randomInt(from.length)]!;

export function generateRecoveryCode(): string {
  const out = RECOVERY_GROUPS.map(pick);
  while (out.length < CODE_LENGTH) out.push(pick(RECOVERY_ALPHABET));
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  const groups: string[] = [];
  for (let i = 0; i < out.length; i += GROUP_SIZE) groups.push(out.slice(i, i + GROUP_SIZE).join(''));
  // Shown as 4-character groups for readability; the hyphens are dropped again when the code is checked.
  return groups.join('-');
}

export function normalizeRecoveryInput(raw: string): string {
  return raw.normalize('NFKC').replace(/[\s\-‐-―−ー]/gu, '');
}
