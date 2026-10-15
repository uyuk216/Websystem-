import { describe, expect, it } from 'vitest';
import {
  RECOVERY_GROUPS, RECOVERY_ALPHABET, generateRecoveryCode, normalizeRecoveryInput,
} from '../src/recovery-code.js';

describe('recovery code', () => {
  it('is 16 chars from the alphabet, NFKC-stable, without confusables', () => {
    const code = generateRecoveryCode();
    expect([...code]).toHaveLength(16);
    expect([...code].every((ch) => RECOVERY_ALPHABET.includes(ch))).toBe(true);
    for (const ch of RECOVERY_ALPHABET) expect(ch.normalize('NFKC')).toBe(ch);
    for (const bad of ['O', '0', 'I', 'l', '1', '口', '力', 'ー', '二', '工', '夕', '卜', '八']) {
      expect(RECOVERY_ALPHABET).not.toContain(bad);
    }
  });

  it('contains every group at least once (1000 codes)', () => {
    for (let i = 0; i < 1000; i++) {
      const chars = [...generateRecoveryCode()];
      for (const g of RECOVERY_GROUPS) {
        expect(chars.some((c) => g.includes(c))).toBe(true);
      }
    }
  });

  it('normalizes full-width, spaces and hyphens', () => {
    expect(normalizeRecoveryInput(' ＡＢ-c d２ ')).toBe('ABcd2');
  });
});
