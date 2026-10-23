'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { VerificationSummary, type ReviewStatus } from '@/components/plan-summary';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const kinds = ['junior_high', 'high_school', 'technical_college', 'vocational', 'university', 'graduate'] as const;
interface Status { verification: ReviewStatus | null }
export default function VerifyPage() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [school, setSchool] = useState('');
  const [kind, setKind] = useState<string>('university');
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const load = useCallback(() => { setError(false); void api<Status>('/verification/status').then(setStatus).catch(() => setError(true)); }, []);
  useEffect(() => { load(); window.addEventListener('focus', load); return () => window.removeEventListener('focus', load); }, [load]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(false);
    try {
      const r = await api<{ uploadUrl: string }>(`/verification/start?locale=${locale}`, { method: 'POST', body: { schoolName: school, schoolKind: kind, expectedGraduationYear: year } });
      window.location.assign(r.uploadUrl);
    } catch { setError(true); setBusy(false); }
  }
  const v = status?.verification;
  const approved = v?.status === 'approved' && v.validUntil && new Date(v.validUntil) > new Date();
  return <>
    <h1>{t('verify.title')}</h1>
    <p>{t('verify.separate')}</p><p className="notice">{t('verification.noEmailNotice')}</p>
    {error && <p role="alert" className="error">{t('verify.error')}</p>}
    <button type="button" className="secondary" onClick={load}>{t('verify.refresh')}</button>
    {status && <VerificationSummary review={status.verification} locale={locale} />}
    <p><Link href={`/${locale}/plan`}>{t('plan.details')}</Link></p>
    {status && !approved && <form className="box" onSubmit={(e) => void submit(e)}>
      <label htmlFor="school">{t('verify.school')}</label><input id="school" required maxLength={100} value={school} onChange={(e) => setSchool(e.target.value)} />
      <label htmlFor="kind">{t('verify.kind')}</label><select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k} value={k}>{t(`verify.school.${k}`)}</option>)}</select>
      <label htmlFor="year">{t('verify.year')}</label><input id="year" type="number" required min={new Date().getFullYear() - 1} max={new Date().getFullYear() + 10} value={year} onChange={(e) => setYear(Number(e.target.value))} />
      <button type="submit" disabled={busy} aria-busy={busy}>{t('verify.submit')}</button>
    </form>}
  </>;
}
