'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function RecoverPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/auth/recovery/request', { method: 'POST', body: { email, recoveryCode: code }, noRedirect: true });
      setState('done');
    } catch {
      setState('failed');
    }
  }

  return (
    <>
      <h1>{t('recover.title')}</h1>
      <p>{t('recover.body')}</p>
      {state === 'done' && <p role="status">{t('recover.done')}</p>}
      {state === 'failed' && <p role="alert" className="error">{t('recover.failed')}</p>}
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="email">{t('common.email')}</label>
        <input id="email" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="rc">{t('recover.code')}</label>
        <input id="rc" name="recoveryCode" autoComplete="off" required value={code} onChange={(e) => setCode(e.target.value)} />
        <button type="submit">{t('recover.submit')}</button>
      </form>
    </>
  );
}
