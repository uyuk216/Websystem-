import { describe, expect, it } from 'vitest';
import {
  RECOVERY_GROUPS, RECOVERY_ALPHABET, generateRecoveryCode, normalizeRecoveryInput,
} from '../src/recovery-code.js';

describe('recovery code', () => {
  it('is 32 ASCII chars in 4-character groups, NFKC-stable, without confusables', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[^-]{4}(-[^-]{4}){7}$/);
    const body = code.replaceAll('-', '');
    expect([...body]).toHaveLength(32);
    expect([...body].every((ch) => RECOVERY_ALPHABET.includes(ch))).toBe(true);
    expect(normalizeRecoveryInput(code)).toBe(body);
    for (const ch of RECOVERY_ALPHABET) expect(ch.normalize('NFKC')).toBe(ch);
    for (const bad of ['O', '0', 'I', 'l', '1', '口', '力', 'ー', '二', '工', '夕', '卜', '八', 'ク', 'ケ', 'シ', 'ツ', 'ソ']) {
      expect(RECOVERY_ALPHABET).not.toContain(bad);
    }
  });

  it('contains every group at least once (1000 codes)', () => {
    for (let i = 0; i < 1000; i++) {
      const chars = [...generateRecoveryCode().replaceAll('-', '')];
      for (const g of RECOVERY_GROUPS) {
        expect(chars.some((c) => g.includes(c))).toBe(true);
      }
    }
  });

  it('normalizes full-width, spaces and hyphens', () => {
    expect(normalizeRecoveryInput(' ＡＢ-c d２ ')).toBe('ABcd2');
  });
});
