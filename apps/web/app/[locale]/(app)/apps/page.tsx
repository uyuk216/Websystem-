'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';
import { siteUrl } from '@/lib/site';

interface AppRow { id: string; name: string }
interface Owner { id: string; kind: 'account' | 'team'; name: string | null }

export default function AppsPage() {
  const { t, locale } = useI18n();
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'static' | 'dynamic'>('static');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<{ apps: AppRow[] }>('/apps').then((r) => setApps(r.apps)).catch(() => setError(t('common.error'))), [t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ owners: Owner[] }>('/me/owners').then((r) => {
      setOwners(r.owners);
      setOwnerId((cur) => cur || (r.owners.find((o) => o.kind === 'account') ?? r.owners[0])?.id || '');
    }).catch(() => setError(t('common.error')));
  }, [t]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/apps', { method: 'POST', body: { name, ownerId, kind } });
      setName('');
      await load();
    } catch (err) { setError(t(err instanceof ApiError ? errorKey(err.code) : 'common.error')); }
  }

  return (
    <>
      <h1>{t('apps.title')}</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {apps?.length === 0 && <p>{t('apps.empty')}</p>}
      <ul>
        {apps?.map((a) => (
          <li key={a.id}><Link href={`/${locale}/apps/${a.id}`}>{a.name}</Link> <span className="muted">{siteUrl(a.name)}</span></li>
        ))}
      </ul>
      <form onSubmit={(e) => void create(e)}>
        <label htmlFor="an">{t('apps.name')}</label>
        <input id="an" name="name" maxLength={100} required value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="ao">{t('apps.owner')}</label>
        <select id="ao" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          {owners.map((o) => <option key={o.id} value={o.id}>{o.kind === 'account' ? t('apps.ownerMe') : o.name}</option>)}
        </select>
        <label htmlFor="ak">{t('apps.kind')}</label>
        <select id="ak" value={kind} onChange={(e) => setKind(e.target.value as 'static' | 'dynamic')}>
          <option value="static">{t('apps.kind.static')}</option>
          <option value="dynamic">{t('apps.kind.dynamic')}</option>
        </select>
        <button type="submit" disabled={!ownerId}>{t('apps.create')}</button>
      </form>
    </>
  );
}
