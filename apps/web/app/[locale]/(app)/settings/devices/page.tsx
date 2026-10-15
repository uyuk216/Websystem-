'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Sess { id: string; deviceLabel: string; createdAt: string; lastSeenAt: string; current: boolean }

export default function DevicesPage() {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Sess[] | null>(null);
  const [error, setError] = useState(false);
  const fmt = (s: string) => new Date(s).toLocaleString(locale);

  const load = useCallback(() => api<{ sessions: Sess[] }>('/me/sessions').then((r) => setRows(r.sessions)).catch(() => setError(true)), []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string) {
    setError(false);
    try {
      await api(`/me/sessions/${id}`, { method: 'DELETE' });
      await load();
    } catch { setError(true); }
  }

  return (
    <>
      <h1>{t('devices.title')}</h1>
      {error && <p role="alert" className="error">{t('common.error')}</p>}
      {rows?.length === 0 && <p>{t('devices.empty')}</p>}
      {rows && rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th scope="col">{t('devices.device')}</th><th scope="col">{t('devices.since')}</th><th scope="col">{t('devices.lastSeen')}</th><th scope="col"><span className="muted" /></th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} data-current={s.current}>
                  <th scope="row">{s.deviceLabel}{s.current && <> <strong>({t('common.current')})</strong></>}</th>
                  <td>{fmt(s.createdAt)}</td>
                  <td>{fmt(s.lastSeenAt)}</td>
                  <td>{!s.current && <button type="button" onClick={() => void revoke(s.id)} aria-label={`${t('devices.revoke')}: ${s.deviceLabel}`}>{t('devices.revoke')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
