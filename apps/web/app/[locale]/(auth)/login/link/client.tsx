'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Opening the mailed link changes state, so it is POSTed from JS (never on GET, which mail scanners prefetch). */
export function LinkClient({ c, token }: { c: string; token: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [state, setState] = useState<'loading' | 'pending' | 'invalid'>('loading');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // single-use link: never POST twice (Strict Mode re-runs effects)
    started.current = true;
    api<{ result: 'logged_in' | 'cross_device_pending' }>('/auth/email/link', { method: 'POST', body: { c, t: token }, noRedirect: true })
      .then((r) => (r.result === 'logged_in' ? router.replace(`/${locale}/settings/devices`) : setState('pending')))
      .catch(() => setState('invalid'));
  }, [c, token, locale, router]);

  return (
    <>
      <h1>{t('login.title')}</h1>
      {state === 'loading' && <p role="status">{t('link.opening')}</p>}
      {state === 'pending' && <p role="status">{t('link.pending')}</p>}
      {state === 'invalid' && <p role="alert" className="error">{t('link.invalid')}</p>}
    </>
  );
}
