import { randomInt } from 'node:crypto';

const chars = (s: string): readonly string[] => [...s];

const UPPER = chars('ABCDEFGHJKLMNPQRSTUVWXYZ');
const LOWER = chars('abcdefghijkmnpqrstuvwxyz');
const DIGIT = chars('23456789');
const SYMBOL = chars('#$%&+=?@');
const HIRAGANA = chars('あいうえかきくけさしすせたちつてなぬねのはひふほまみむめもやゆよらるれわ');
const KATAKANA = chars('アイウエオキサスセタチテトナヌネノハフホマミムメモヤユヨラルレワ');
const KANJI = chars('山川空海森林花鳥風雪雲星月火水金土木春夏秋冬朝夜東西南北虫魚犬猫竹石光音');

/** Groups a code must each contribute at least one character from (hiragana and katakana share one). */
export const RECOVERY_GROUPS: readonly (readonly string[])[] = [UPPER, LOWER, DIGIT, SYMBOL, [...HIRAGANA, ...KATAKANA], KANJI];

export const RECOVERY_ALPHABET: readonly string[] = RECOVERY_GROUPS.flat();

const CODE_LENGTH = 16;

const pick = (from: readonly string[]): string => from[randomInt(from.length)]!;

export function generateRecoveryCode(): string {
  const out = RECOVERY_GROUPS.map(pick);
  while (out.length < CODE_LENGTH) out.push(pick(RECOVERY_ALPHABET));
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.join('');
}

export function normalizeRecoveryInput(raw: string): string {
  return raw.normalize('NFKC').replace(/[\s\-‐-―−ー]/gu, '');
}
