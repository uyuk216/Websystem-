'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { t } from 'i18n';
import { api, ApiError } from '@/lib/api';

type Incident = { id: string; reason: string; action: string; status: string };
export default function SecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: language } = use(params);
  const locale = language === 'en' ? 'en' : 'ja';
  const [notices, setNotices] = useState<{ id: string; subject: string; body: string }[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [signedIn, setSignedIn] = useState(true);
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const load = useCallback(() => { void api<{ incidents: Incident[] }>(`/security/incidents?locale=${locale}`, { noRedirect: true }).then((r) => { setSignedIn(true); setIncidents(r.incidents); void api<{ notifications: { id: string; subject: string; body: string }[] }>('/security/notifications', { noRedirect: true }).then((n) => setNotices(n.notifications)).catch(() => setStatus(t(locale, 'common.error'))); }).catch((e: unknown) => { if (e instanceof ApiError && e.status === 401) setSignedIn(false); else setStatus(t(locale, 'common.error')); }); }, [locale]);
  useEffect(load, [load]);
  return <main><h1>{t(locale, 'security.title')}</h1><p>{t(locale, 'security.action')}</p>
    <p role="status">{status}</p>
    {!signedIn && <form onSubmit={(event) => { event.preventDefault(); setSending(true); const work = challenge
      ? api('/security/session/verify', { method: 'POST', noRedirect: true, body: { challengeId: challenge, code } }).then(() => { load(); })
      : api<{ challengeId: string }>('/security/session/start', { method: 'POST', noRedirect: true, body: { email, locale } }).then((r) => setChallenge(r.challengeId));
      void work.catch(() => setStatus(t(locale, 'common.error'))).finally(() => setSending(false)); }}>
      <label>{t(locale, 'security.email')}<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      {challenge && <label>{t(locale, 'security.code')}<input required inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} /></label>}
      <button disabled={sending} type="submit">{t(locale, 'security.identity')}</button>
    </form>}
    {notices.map((notice) => <aside className="box" key={notice.id}><h2>{notice.subject}</h2><p>{notice.body}</p></aside>)}
    {incidents.map((incident) => <section key={incident.id} className="box"><h2>{incident.id}</h2><p>{incident.reason}</p><p>{incident.status}</p>
      <form onSubmit={(event) => { event.preventDefault(); setSending(true); void api(`/security/incidents/${incident.id}/appeals`, { method: 'POST', body: { message: messages[incident.id] } }).then(() => { setStatus(t(locale, 'security.sent')); setMessages((m) => ({ ...m, [incident.id]: '' })); }).catch(() => setStatus(t(locale, 'common.error'))).finally(() => setSending(false)); }}>
        <label>{t(locale, 'security.appeal')}<textarea required maxLength={2000} value={messages[incident.id] ?? ''} onChange={(event) => setMessages((m) => ({ ...m, [incident.id]: event.target.value }))} /></label>
        <button disabled={sending} type="submit">{t(locale, 'security.appeal')}</button>
      </form></section>)}
    <button onClick={() => { void api('/auth/logout', { method: 'POST' }).then(() => { window.location.href = `/${locale}/login`; }).catch(() => setStatus(t(locale, 'common.error'))); }}>{t(locale, 'security.logout')}</button>
  </main>;
}
