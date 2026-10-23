'use client';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { MessageKey } from 'i18n';

interface Status {
  application: { status: 'pending' | 'approved' | 'rejected'; rejectReason: string | null } | null;
  grant: { endsAt: string; daysLeft: number } | null;
}

export default function StarterPage() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState({ project: '', githubLogin: '', introduction: '' });
  const [error, setError] = useState<MessageKey | null>(null);
  const [sent, setSent] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [smsStep, setSmsStep] = useState<'phone' | 'code' | 'done'>('phone');
  const [smsError, setSmsError] = useState<MessageKey | null>(null);
  const load = useCallback(() => api<Status>('/starter/status').then(setStatus).catch(() => setError('common.error')), []);
  useEffect(() => { void load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/starter/apply', { method: 'POST', body: form });
      setSent(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (`starter.error.${err.code}` as MessageKey) : 'common.error');
    }
  }
  async function sms(path: 'request' | 'confirm') {
    setSmsError(null);
    try {
      await api(`/starter/sms/${path}`, { method: 'POST', body: path === 'request' ? { phone } : { phone, code } });
      setSmsStep(path === 'request' ? 'code' : 'done');
    } catch (err) {
      setSmsError(err instanceof ApiError ? (`starter.sms.error.${err.code}` as MessageKey) : 'common.error');
    }
  }

  const app = status?.application;
  const canApply = !app || app.status === 'rejected';
  return (
    <>
      <h1>{t('starter.title')}</h1>
      <p>{t('starter.lead')}</p>
      {app?.status === 'pending' && <p role="status">{t('starter.statusPending')}</p>}
      {app?.status === 'rejected' && <p role="status">{t('starter.statusRejected', { reason: app.rejectReason ?? '' })}</p>}
      {status?.grant && (
        <p role="status">
          {t('starter.statusApproved', { endsAt: new Date(status.grant.endsAt).toLocaleDateString(locale) })}
          {status.grant.daysLeft <= 14 && <> {t('starter.endingSoon', { days: status.grant.daysLeft })}</>}
        </p>
      )}
      {sent && <p role="status">{t('starter.sent')}</p>}
      {error && <p role="alert" className="error">{t(error)}</p>}
      {canApply && (
        <>
          <form className="box" onSubmit={(e) => e.preventDefault()} aria-label="SMS">
            {smsStep === 'phone' && (<>
              <label htmlFor="sp">{t('starter.sms.phone')}</label>
              <input id="sp" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <button type="button" onClick={() => void sms('request')}>{t('starter.sms.send')}</button>
            </>)}
            {smsStep === 'code' && (<>
              <label htmlFor="sc">{t('starter.sms.code')}</label>
              <input id="sc" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="button" onClick={() => void sms('confirm')}>{t('starter.sms.verify')}</button>
            </>)}
            {smsStep === 'done' && <p role="status">{t('starter.sms.done')}</p>}
            {smsError && <p role="alert" className="error">{t(smsError)}</p>}
          </form>
          <form className="box" onSubmit={(e) => void submit(e)}>
            <label htmlFor="sj">{t('starter.project')}</label>
            <textarea id="sj" required maxLength={1000} value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} />
            <label htmlFor="sg">{t('starter.github')}</label>
            <input id="sg" required maxLength={39} value={form.githubLogin} onChange={(e) => setForm({ ...form, githubLogin: e.target.value })} />
            <label htmlFor="si">{t('starter.intro')}</label>
            <textarea id="si" required maxLength={2000} value={form.introduction} onChange={(e) => setForm({ ...form, introduction: e.target.value })} />
            <button type="submit">{t('starter.submit')}</button>
          </form>
        </>
      )}
    </>
  );
}
