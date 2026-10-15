'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Tok { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }

export default function TokensPage() {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Tok[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => api<{ tokens: Tok[] }>('/me/tokens').then((r) => setRows(r.tokens)).catch(() => setError(true)), []);
  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(false);
    try {
      const r = await api<{ id: string; token: string }>('/me/tokens', { method: 'POST', body: { name } });
      setCreated(r.token); // kept only in memory: shown once, never stored
      setName('');
      await load();
    } catch { setError(true); }
  }

  async function revoke(id: string) {
    setError(false);
    try { await api(`/me/tokens/${id}`, { method: 'DELETE' }); await load(); } catch { setError(true); }
  }

  return (
    <>
      <h1>{t('tokens.title')}</h1>
      {error && <p role="alert" className="error">{t('common.error')}</p>}
      {created && (
        <div role="status">
          <p>{t('tokens.shownOnce')}</p>
          <code data-testid="new-token">{created}</code>
          <button type="button" className="secondary" onClick={() => setCreated(null)}>{t('common.close')}</button>
        </div>
      )}
      <form onSubmit={(e) => void create(e)}>
        <label htmlFor="tkn">{t('tokens.name')}</label>
        <input id="tkn" maxLength={100} required value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">{t('tokens.create')}</button>
      </form>
      {rows?.length === 0 && <p>{t('tokens.empty')}</p>}
      {rows && rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th scope="col">{t('tokens.name')}</th><th scope="col">{t('tokens.prefix')}</th><th scope="col">{t('tokens.created')}</th><th scope="col">{t('tokens.lastUsed')}</th><th scope="col" /></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <th scope="row">{k.name}</th>
                  <td><code>{k.prefix}</code></td>
                  <td>{new Date(k.createdAt).toLocaleString(locale)}</td>
                  <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString(locale) : t('tokens.never')}</td>
                  <td><button type="button" onClick={() => void revoke(k.id)} aria-label={`${t('tokens.revoke')}: ${k.name}`}>{t('tokens.revoke')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
