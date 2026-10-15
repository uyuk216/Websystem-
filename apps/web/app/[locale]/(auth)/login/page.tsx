'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';

type Screen = { state: 'awaiting_scan'; qrPayload: string; number: number } | { state: 'approved' } | { state: 'none' };

export default function LoginPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const home = `/${locale}/settings/devices`;
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [qr, setQr] = useState<{ src: string; payload: string; number: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completing = useRef(false);

  // While waiting for the mailed link, poll the requester screen every 2 seconds.
  useEffect(() => {
    if (!challengeId) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<Screen>(`/auth/email/screen?c=${encodeURIComponent(challengeId)}`, { noRedirect: true });
        if (stop) return;
        if (s.state === 'awaiting_scan') {
          const src = await QRCode.toDataURL(s.qrPayload, { margin: 2, width: 240 });
          if (!stop) setQr({ src, payload: s.qrPayload, number: s.number });
        } else if (s.state === 'approved' && !completing.current) {
          completing.current = true;
          await api('/auth/email/complete', { method: 'POST', body: { challengeId }, noRedirect: true });
          router.push(home);
        } else {
          setQr(null);
        }
      } catch {
        /* transient; try again on the next tick */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => { stop = true; clearInterval(id); };
  }, [challengeId, home, router]);

  const fail = (e: unknown) => setError(t(e instanceof ApiError ? errorKey(e.code) : 'common.error'));

  async function passkey() {
    setError(null);
    try {
      const { challengeId: cid, options } = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/auth/passkey/login/start', { method: 'POST', body: {}, noRedirect: true });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/auth/passkey/login/finish', { method: 'POST', body: { challengeId: cid, response }, noRedirect: true });
      router.push(home);
    } catch {
      setError(t('login.passkeyFailed'));
    }
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ challengeId: string }>('/auth/email/start', { method: 'POST', body: { email, purpose: 'login', locale }, noRedirect: true });
      setChallengeId(r.challengeId);
    } catch (err) { fail(err); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/auth/email/verify', { method: 'POST', body: { challengeId, code }, noRedirect: true });
      router.push(home);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'locked' ? t('login.locked') : err instanceof ApiError && err.status === 429 ? t('login.locked') : t('login.codeWrong'));
    }
  }

  return (
    <>
      <h1>{t('login.title')}</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {!challengeId ? (
        <>
          <button type="button" onClick={() => void passkey()}>{t('login.passkeyButton')}</button>
          <form onSubmit={(e) => void sendCode(e)}>
            <label htmlFor="email">{t('common.email')}</label>
            <input id="email" type="email" name="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <button type="submit">{t('login.emailButton')}</button>
          </form>
          <p>{t('login.noAccount')} <Link href={`/${locale}/signup`}>{t('login.signupLink')}</Link></p>
          <p><Link href={`/${locale}/recover`}>{t('login.recoverLink')}</Link></p>
        </>
      ) : (
        <>
          <h2>{t('login.waitingTitle')}</h2>
          <p role="status">{t('login.codeSent', { email })}</p>
          <p>{t('login.waitingBody')}</p>
          <form onSubmit={(e) => void verify(e)}>
            <label htmlFor="code">{t('login.codeLabel')}</label>
            <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit">{t('login.verify')}</button>
          </form>
          {qr && (
            <section aria-live="polite">
              <img src={qr.src} alt={t('login.qrAlt')} width={240} height={240} data-testid="login-qr" data-payload={qr.payload} />
              <p>{t('login.yourNumber')}</p>
              <p className="number" data-testid="login-number">{qr.number}</p>
            </section>
          )}
        </>
      )}
    </>
  );
}
