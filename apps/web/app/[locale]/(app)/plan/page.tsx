'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PlanSummary, type PlanStatus } from '@/components/plan-summary';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function PlanPage() {
  const { t, locale } = useI18n();
  const [plan, setPlan] = useState<PlanStatus | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => { setError(false); void api<PlanStatus>('/plan').then(setPlan).catch(() => setError(true)); }, []);
  useEffect(() => { load(); window.addEventListener('focus', load); return () => window.removeEventListener('focus', load); }, [load]);
  return <>
    <h1>{t('plan.title')}</h1>
    {error && <p className="error" role="alert">{t('common.error')}</p>}
    <button type="button" className="secondary" onClick={load}>{t('verify.refresh')}</button>
    {plan && <PlanSummary plan={plan} locale={locale} />}
    <section className="box"><h2>{t('plan.schedule')}</h2><ul><li>{t('plan.march')}</li><li>{t('plan.april')}</li><li>{t('plan.may')}</li></ul></section>
    <p><Link href={`/${locale}/verify`}>{t('verify.title')}</Link></p>
    <p><Link href={`/${locale}/starter`}>{t('plan.starterLink')}</Link></p>
    <p>{t('plan.boostLink')} <Link href={`/${locale}/apps`}>{t('plan.apps')}</Link></p>
  </>;
}
