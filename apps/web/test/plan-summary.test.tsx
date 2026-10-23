import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { t } from 'i18n';
import { PlanSummary, VerificationSummary } from '../components/plan-summary';

for (const locale of ['ja', 'en'] as const) {
  describe(`${locale} account summaries`, () => {
    it('switches from no plan to Student and shows Japan-time expiry and stop dates', () => {
      const none = renderToStaticMarkup(createElement(PlanSummary, { locale, plan: { plan: 'none', endsAt: null, suspendOn: null } }));
      expect(none).toContain(t(locale, 'plan.none'));
      expect(none).toContain(t(locale, 'plan.noDate'));
      const student = renderToStaticMarkup(createElement(PlanSummary, { locale, plan: { plan: 'student', endsAt: '2027-03-31T14:59:59.999Z', suspendOn: '2027-04-30T15:00:00.000Z' } }));
      expect(student).toContain('<h2>Student</h2>');
      expect(student).toContain(new Date('2027-05-01T00:00:00+09:00').toLocaleDateString(locale, { timeZone: 'Asia/Tokyo' }));
      expect(student).toContain(t(locale, 'plan.help.student'));
    });
    it('renders review outcomes and escapes an operator-provided rejection reason', () => {
      for (const status of ['pending', 'approved', 'expired'] as const) {
        const html = renderToStaticMarkup(createElement(VerificationSummary, { locale, review: { status, rejectReason: null, validUntil: null } }));
        expect(html).toContain(t(locale, `verify.${status}`));
      }
      const html = renderToStaticMarkup(createElement(VerificationSummary, { locale, review: { status: 'rejected', rejectReason: '<script>alert(1)</script>', validUntil: null } }));
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      expect(renderToStaticMarkup(createElement(VerificationSummary, { locale, review: null }))).toContain(t(locale, 'verify.none'));
    });
  });
}
