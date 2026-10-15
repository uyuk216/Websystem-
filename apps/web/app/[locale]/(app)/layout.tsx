'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Signed-in shell: a 401 from any API call sends the user to the login page (see lib/api). */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { t, locale } = useI18n();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailed(false);
    // A 401 is handled by lib/api (redirect to login); anything else shows a retryable error.
    api('/me/sessions').then(() => setReady(true)).catch((e: unknown) => {
      if (!(e instanceof ApiError && e.status === 401)) setFailed(true);
    });
  }, [attempt]);

  async function logout() {
    await api('/auth/logout', { method: 'POST', noRedirect: true }).catch(() => undefined);
    window.location.href = `/${locale}/login`;
  }

  if (failed) {
    return (
      <main>
        <p role="alert" className="error">{t('common.loadError')}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</button>
      </main>
    );
  }
  if (!ready) return <main><p role="status">{t('common.loading')}</p></main>;
  return (
    <>
      <header className="shell">
        <strong>{t('app.name')}</strong>
        <nav aria-label="main">
          <Link href={`/${locale}/apps`}>{t('nav.apps')}</Link>
          <Link href={`/${locale}/settings/tokens`}>{t('nav.tokens')}</Link>
          <Link href={`/${locale}/settings/devices`}>{t('nav.devices')}</Link>
          <Link href={`/${locale}/settings/logins`}>{t('nav.logins')}</Link>
          <Link href={`/${locale}/settings/passkeys`}>{t('nav.passkeys')}</Link>
          <Link href={`/${locale}/teams`}>{t('nav.teams')}</Link>
        </nav>
        <button type="button" className="secondary" onClick={() => void logout()}>{t('nav.logout')}</button>
      </header>
      <main>{children}</main>
    </>
  );
}
