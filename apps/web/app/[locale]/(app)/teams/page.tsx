'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';
import type { MessageKey } from 'i18n';

const roleKey: Record<string, MessageKey> = { owner: 'teams.owner', admin: 'teams.admin', member: 'teams.member' };

export default function TeamsPage() {
  const { t, locale } = useI18n();
  const [teams, setTeams] = useState<{ id: string; name: string; role: string }[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ teams: { id: string; name: string; role: string }[] }>('/teams').then((r) => setTeams(r.teams)).catch(() => setError(t('common.error'))), [t]);
  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/teams', { method: 'POST', body: { name } });
      setName('');
      await load();
    } catch (err) { setError(t(err instanceof ApiError ? errorKey(err.code) : 'common.error')); }
  }

  return (
    <>
      <h1>{t('teams.title')}</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {teams?.length === 0 && <p>{t('teams.empty')}</p>}
      <ul>
        {teams?.map((x) => <li key={x.id}><Link href={`/${locale}/teams/${x.id}`}>{x.name}</Link> <span className="muted">({t(roleKey[x.role] ?? 'teams.member')})</span></li>)}
      </ul>
      <form onSubmit={(e) => void create(e)}>
        <label htmlFor="tn">{t('teams.name')}</label>
        <input id="tn" name="name" maxLength={100} required value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">{t('teams.create')}</button>
      </form>
    </>
  );
}
