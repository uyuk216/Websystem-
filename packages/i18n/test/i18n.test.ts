import { describe, expect, it } from 'vitest';
import { t } from '../src/index.js';
import { en } from '../src/en.js';
import { ja } from '../src/ja.js';

describe('t', () => {
  it('interpolates {name} placeholders in both locales', () => {
    expect(t('ja', 'login.codeSent', { email: 'a@b.c' })).toContain('a@b.c');
    expect(t('en', 'login.codeSent', { email: 'a@b.c' })).toContain('a@b.c');
  });

  it('leaves a placeholder intact when its param is missing', () => {
    expect(t('en', 'login.codeSent')).toContain('{email}');
  });
});

describe('message catalogs', () => {
  it('have identical key sets in ja and en', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });
});
