'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';
import { registerPasskey } from '@/lib/passkey';

type Step = 'email' | 'code' | 'profile' | 'recovery' | 'passkey';

export default function SignupPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [lang, setLang] = useState<'ja' | 'en'>(locale);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const home = `/${locale}/settings/devices`;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ challengeId: string }>('/auth/email/start', { method: 'POST', body: { email, purpose: 'signup', locale }, noRedirect: true });
      setChallengeId(r.challengeId);
      setStep('code');
    } catch (err) { setError(t(err instanceof ApiError ? errorKey(err.code) : 'common.error')); }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ recoveryCode: string }>('/auth/signup', { method: 'POST', body: { challengeId, code, email, displayName, birthDate, locale: lang }, noRedirect: true });
      setRecoveryCode(r.recoveryCode);
      setStep('recovery');
    } catch (err) {
      const c = err instanceof ApiError ? err.code : '';
      setError(c === 'under13' ? t('age.under13') : c === 'exists' ? t('signup.exists') : c === 'invalid' ? t('login.codeWrong') : t(err instanceof ApiError ? errorKey(c) : 'common.error'));
      if (c === 'invalid') setStep('code');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
    } catch { /* clipboard unavailable: the code is still on screen */ }
  }

  async function addPasskey() {
    setError(null);
    try {
      await registerPasskey();
      router.push(home);
    } catch {
      setError(t('passkeys.failed'));
    }
  }

  return (
    <>
      <h1>{t('signup.title')}</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {step === 'email' && (
        <form onSubmit={(e) => void start(e)}>
          <h2>{t('signup.stepEmail')}</h2>
          <label htmlFor="email">{t('common.email')}</label>
          <input id="email" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit">{t('login.sendCode')}</button>
          <p><Link href={`/${locale}/login`}>{t('login.title')}</Link></p>
        </form>
      )}
      {step === 'code' && (
        <form onSubmit={(e) => { e.preventDefault(); setError(null); setStep('profile'); }}>
          <h2>{t('signup.stepCode')}</h2>
          <p role="status">{t('login.codeSent', { email })}</p>
          <label htmlFor="code">{t('login.codeLabel')}</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="submit">{t('common.next')}</button>
        </form>
      )}
      {step === 'profile' && (
        <form onSubmit={(e) => void create(e)}>
          <h2>{t('signup.stepProfile')}</h2>
          <label htmlFor="dn">{t('signup.displayName')}</label>
          <input id="dn" name="displayName" maxLength={100} required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <label htmlFor="bd">{t('signup.birthDate')}</label>
          <input id="bd" name="birthDate" type="date" required value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          <label htmlFor="lang">{t('signup.locale')}</label>
          <select id="lang" name="locale" value={lang} onChange={(e) => setLang(e.target.value === 'en' ? 'en' : 'ja')}>
            <option value="ja">{t('common.ja')}</option>
            <option value="en">{t('common.en')}</option>
          </select>
          <button type="submit">{t('signup.submit')}</button>
        </form>
      )}
      {step === 'recovery' && (
        <section>
          <h2>{t('signup.recoveryTitle')}</h2>
          <p>{t('signup.recoveryWarn')}</p>
          <code className="recovery" data-testid="recovery-code">{recoveryCode}</code>
          <button type="button" className="secondary" onClick={() => void copy()}>{copied ? t('signup.copied') : t('signup.copy')}</button>
          <button type="button" className="secondary" onClick={() => window.print()}>{t('signup.print')}</button>
          <p>
            <label className="noprint">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              {t('signup.saved')}
            </label>
          </p>
          <button type="button" disabled={!saved} onClick={() => { setRecoveryCode(''); setStep('passkey'); }}>{t('common.next')}</button>
        </section>
      )}
      {step === 'passkey' && (
        <section>
          <h2>{t('signup.passkeyTitle')}</h2>
          <p>{t('signup.passkeyBody')}</p>
          <button type="button" onClick={() => void addPasskey()}>{t('passkeys.add')}</button>
          <button type="button" className="secondary" onClick={() => router.push(home)}>{t('signup.passkeySkip')}</button>
        </section>
      )}
    </>
  );
}
