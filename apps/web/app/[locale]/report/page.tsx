'use client';
import { use, useEffect, useState } from 'react';
import { t } from 'i18n';
import { api } from '@/lib/api';
export default function ReportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: language } = use(params); const locale = language === 'en' ? 'en' : 'ja';
  const [appId, setAppId] = useState(''); const [category, setCategory] = useState('phishing'); const [status, setStatus] = useState('');
  useEffect(() => { setAppId(new URLSearchParams(window.location.search).get('app') ?? ''); }, []);
  return <main><h1>{t(locale, 'report.title')}</h1><form onSubmit={event => { event.preventDefault(); void api('/security/reports', { method: 'POST', body: { appId, category } }).then(() => setStatus(t(locale, 'report.sent'))).catch(() => setStatus(t(locale, 'common.error'))); }}>
    <label>{t(locale, 'report.category')}<select value={category} onChange={event => setCategory(event.target.value)}><option value="phishing">Phishing</option><option value="malware">Malware</option><option value="abuse">Abuse</option></select></label>
    <button type="submit" disabled={!/^[a-f0-9-]{36}$/i.test(appId)}>{t(locale, 'report.title')}</button></form><p role="status">{status}</p></main>;
}
