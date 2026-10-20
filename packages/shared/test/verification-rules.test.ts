import { describe, expect, it } from 'vitest';
import { assessEligibility, endOfMarchJst } from '../src/verification-rules.js';

const jst = (s: string) => new Date(`${s}+09:00`);

describe('assessEligibility', () => {
  it('January-February: enrolled while the graduation year is this year or later; valid until this March 31', () => {
    const v = assessEligibility(2027, jst('2027-02-10T12:00:00'));
    expect(v).toMatchObject({ enrolled: true, requiresNewFiscalYearDoc: false });
    expect(v.validUntil).toEqual(endOfMarchJst(2027));
    expect(assessEligibility(2026, jst('2027-02-10T12:00:00')).enrolled).toBe(false);
  });
  it('March: judged for the next fiscal year by graduation year (graduating this March is not enrolled)', () => {
    const now = jst('2027-03-15T12:00:00');
    expect(assessEligibility(2027, now).enrolled).toBe(false);
    const ok = assessEligibility(2028, now);
    expect(ok).toMatchObject({ enrolled: true, requiresNewFiscalYearDoc: false });
    expect(ok.validUntil).toEqual(endOfMarchJst(2028));
  });
  it('April onwards: new-year document required; valid until next March 31', () => {
    const now = jst('2027-04-01T00:00:00');
    expect(assessEligibility(2028, now)).toMatchObject({ enrolled: true, requiresNewFiscalYearDoc: true, validUntil: endOfMarchJst(2028) });
    expect(assessEligibility(2027, now).enrolled).toBe(false);
  });
  it('uses JST at the month boundary', () => {
    // 2027-03-31 16:00 UTC is already April 1st in Japan.
    expect(assessEligibility(2028, new Date('2027-03-31T16:00:00Z')).requiresNewFiscalYearDoc).toBe(true);
    expect(assessEligibility(2028, new Date('2027-03-31T14:00:00Z')).requiresNewFiscalYearDoc).toBe(false);
  });
  it('endOfMarchJst is 23:59:59.999 JST on March 31st', () => {
    expect(endOfMarchJst(2028).toISOString()).toBe('2028-03-31T14:59:59.999Z');
  });
});
