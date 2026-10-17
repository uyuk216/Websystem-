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
  const [downloaded, setDownloaded] = useState<string | null>(null);
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

  /** Builds the .txt in the browser only; the code is never sent anywhere. */
  function download() {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const file = `recovery-code-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.txt`;
    const text = [
      `${t('app.name')}${t('signup.recoveryFileIntro')}`,
      '',
      recoveryCode,
      '',
      `${t('signup.recoveryFileCreated')}: ${now.toLocaleString(locale)}`,
      t('signup.recoveryFileHow'),
      t('signup.recoveryFileKeep'),
      '',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(file);
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
        <section className="recovery-card">
          <h2>{t('signup.recoveryTitle')}</h2>
          <p>{t('signup.recoveryLead')}</p>
          <p className="notice" role="note"><strong>{t('signup.recoveryWarn')}</strong></p>
          <p className="recovery-label" id="rc-label">{t('signup.recoveryLabel')}</p>
          <code className="recovery" data-testid="recovery-code" aria-labelledby="rc-label">
            {recoveryCode.split('-').map((g, i) => <span key={i}>{i > 0 && '-'}{g}</span>)}
          </code>
          <div className="actions noprint">
            <button type="button" onClick={download}>{t('signup.download')} (.txt)</button>
            <button type="button" className="secondary" onClick={() => void copy()}>{copied ? t('signup.copied') : t('signup.copy')}</button>
            <button type="button" className="secondary" onClick={() => window.print()}>{t('signup.print')}</button>
          </div>
          <p role="status" className="ok noprint">{downloaded ? `✓ ${t('signup.downloaded', { file: downloaded })}` : ''}</p>
          <div className="tips noprint">
            <h3>{t('signup.recoveryTipsTitle')}</h3>
            <ul>
              <li>{t('signup.recoveryTip1')}</li>
              <li>{t('signup.recoveryTip2')}</li>
              <li>{t('signup.recoveryTip3')}</li>
            </ul>
          </div>
          <label className="confirm noprint">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            {t('signup.saved')}
          </label>
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
