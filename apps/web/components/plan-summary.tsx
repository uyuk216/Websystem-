import { t, type Locale } from 'i18n';

export interface PlanStatus { plan: 'none' | 'student' | 'starter'; endsAt: string | null; suspendOn: string | null }
export interface ReviewStatus { status: 'pending' | 'approved' | 'rejected' | 'expired'; rejectReason: string | null; validUntil: string | null }
const date = (locale: Locale, value: string | null) => value
  ? new Date(value).toLocaleDateString(locale, { timeZone: 'Asia/Tokyo' }) : t(locale, 'plan.noDate');

export function PlanSummary({ plan, locale }: { plan: PlanStatus; locale: Locale }) {
  return <section className="box" aria-label={t(locale, 'plan.title')}>
    <h2>{t(locale, `plan.${plan.plan}`)}</h2>
    <dl><dt>{t(locale, 'plan.ends')}</dt><dd>{date(locale, plan.endsAt)}</dd>
      <dt>{t(locale, 'plan.suspends')}</dt><dd>{date(locale, plan.suspendOn)}</dd></dl>
    <p>{t(locale, `plan.help.${plan.plan}`)}</p>
  </section>;
}

export function VerificationSummary({ review, locale }: { review: ReviewStatus | null; locale: Locale }) {
  return <>
    <p role="status">{review ? t(locale, `verify.${review.status}`, { reason: review.rejectReason ?? '' }) : t(locale, 'verify.none')}</p>
    {review?.validUntil && <p>{t(locale, 'plan.ends')}: {date(locale, review.validUntil)}</p>}
  </>;
}
