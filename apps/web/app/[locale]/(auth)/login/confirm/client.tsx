'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Choices { choices: number[]; requesterDevice: string; region: string | null }

export function ConfirmClient({ c, s }: { c: string; s: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<Choices | null>(null);
  const [result, setResult] = useState<'approved' | 'mismatch' | 'invalid' | null>(null);

  useEffect(() => {
    let live = true;
    api<Choices>(`/auth/email/confirm?c=${encodeURIComponent(c)}&s=${encodeURIComponent(s)}`, { noRedirect: true })
      .then((r) => live && setData(r))
      .catch(() => live && setResult('invalid'));
    return () => { live = false; };
  }, [c, s]);

  async function choose(n: number) {
    try {
      await api('/auth/email/confirm', { method: 'POST', body: { challengeId: c, scanToken: s, chosen: n }, noRedirect: true });
      setResult('approved');
    } catch (e) {
      setResult(e instanceof ApiError && e.code === 'mismatch' ? 'mismatch' : 'invalid');
    }
  }

  return (
    <>
      <h1>{t('confirm.title')}</h1>
      {result === 'approved' && <p role="status">{t('confirm.approved')}</p>}
      {result === 'mismatch' && <p role="alert" className="error">{t('confirm.mismatch')}</p>}
      {result === 'invalid' && <p role="alert" className="error">{t('confirm.invalid')}</p>}
      {data && !result && (
        <>
          <p>{t('confirm.body')}</p>
          <dl>
            <dt>{t('confirm.device')}</dt>
            <dd>{data.requesterDevice}</dd>
            <dt>{t('confirm.region')}</dt>
            <dd>{data.region ?? t('confirm.regionUnknown')}</dd>
          </dl>
          <p id="choose-label">{t('confirm.choose')}</p>
          <div className="choices" role="group" aria-labelledby="choose-label">
            {data.choices.map((n) => <button key={n} type="button" onClick={() => void choose(n)}>{n}</button>)}
          </div>
        </>
      )}
    </>
  );
}
