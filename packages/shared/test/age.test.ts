import { describe, expect, it } from 'vitest';
import { checkAge } from '../src/age.js';

const today = new Date('2026-10-15');

describe('checkAge', () => {
  it('accepts a user exactly 13 today and reports adultFrom as the year-month they turn 18', () => {
    expect(checkAge('2013-10-15', today)).toEqual({ ok: true, adultFrom: '2031-10' });
  });

  it('rejects a user who turns 13 tomorrow', () => {
    expect(checkAge('2013-10-16', today)).toEqual({ ok: false, reason: 'under13' });
  });

  it('handles leap-day birthdays by year-month', () => {
    expect(checkAge('2000-02-29', today)).toEqual({ ok: true, adultFrom: '2018-02' });
  });

  it('handles years below 100 correctly (year 0 is a leap year)', () => {
    expect(checkAge('0000-02-29', today)).toEqual({ ok: true, adultFrom: '0018-02' });
  });

  it('rejects impossible calendar dates', () => {
    expect(checkAge('2026-13-01', today)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkAge('2001-02-29', today)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects malformed strings', () => {
    expect(checkAge('2000-1-1', today)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkAge('not-a-date', today)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects future birth dates as invalid', () => {
    expect(checkAge('2030-01-01', today)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('treats a birth date equal to today as under 13', () => {
    expect(checkAge('2026-10-15', today)).toEqual({ ok: false, reason: 'under13' });
  });
});
