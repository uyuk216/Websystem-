'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';
import type { MessageKey } from 'i18n';

interface DbView { status: 'creating' | 'ready' | 'failed'; sizeBytes: number; limitBytes: number; writeMode: 'normal' | 'read_only' | 'blocked'; checkedAt: string | null }
interface Backup { id: string; at: string; sizeBytes: number }

const mb = (n: number) => (n / 1048576).toFixed(1);
/** "512 KB" below 1 MB, otherwise "1.5 MB". */
const size = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${mb(n)} MB`);

/** The app's database: add/remove, usage, write protection and backups. Passwords are never shown. */
export function DatabasePanel({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const [db, setDb] = useState<DbView | null | undefined>(undefined);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((err: unknown) => {
    const code = err instanceof ApiError ? err.code : '';
    const known: Record<string, MessageKey> = { unavailable: 'db.unavailable', failed: 'db.failed', exists: 'db.exists' };
    setError(t(known[code] ?? (err instanceof ApiError ? errorKey(code) : 'common.error')));
  }, [t]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ database: DbView | null }>(`/apps/${id}/database`);
      setDb(r.database);
      if (r.database?.status === 'ready') setBackups((await api<{ backups: Backup[] }>(`/apps/${id}/database/backups`)).backups);
    } catch (err) { fail(err); }
  }, [id, fail]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, done: MessageKey, confirmKey?: MessageKey) {
    if (confirmKey && !window.confirm(t(confirmKey))) return;
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); setMsg(t(done)); await load(); } catch (err) { fail(err); } finally { setBusy(false); }
  }

  if (db === undefined) return null;
  const pct = db ? Math.min(100, Math.round((db.sizeBytes / db.limitBytes) * 100)) : 0;

  return (
    <section className="box" data-testid="database-panel">
      <h2>{t('db.title')}</h2>
      <p className="muted">{t('db.help')}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <p role="status" className="ok">{msg ?? ''}</p>

      {db === null && (
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => void act(() => api(`/apps/${id}/database`, { method: 'POST' }), 'db.added')}>
          {busy ? t('db.adding') : t('db.add')}
        </button>
      )}

      {db && (
        <>
          {db.status !== 'ready' && <p className={db.status === 'failed' ? 'error' : 'muted'}>{t(db.status === 'failed' ? 'db.statusFailed' : 'db.statusCreating')}</p>}
          {db.status === 'failed' && <button type="button" disabled={busy} onClick={() => void act(() => api(`/apps/${id}/database`, { method: 'POST' }), 'db.added')}>{t('db.retry')}</button>}
          {db.status === 'ready' && (
            <>
              <p>{t('db.ready')}</p>
              <label htmlFor="db-usage">{t('db.usage', { used: mb(db.sizeBytes), limit: mb(db.limitBytes) })}</label>
              <progress id="db-usage" max={100} value={pct} className={pct >= 80 ? 'warn' : undefined}>{pct}%</progress>
              {db.writeMode === 'read_only' && <p className="notice" role="note">{t('db.readOnly')}</p>}
              {db.writeMode === 'blocked' && <p className="notice" role="note">{t('db.blocked')}</p>}

              <h3>{t('db.backups')}</h3>
              <p className="muted">{t('db.backupsHelp')}</p>
              <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api(`/apps/${id}/database/backups`, { method: 'POST' }), 'db.backedUp')}>{t('db.backupNow')}</button>
              {backups.length === 0 ? <p className="blankslate">{t('db.noBackups')}</p> : (
                <div className="scroll">
                  <table>
                    <thead><tr><th scope="col">{t('db.backupAt')}</th><th scope="col">{t('db.backupSize')}</th><th scope="col" /></tr></thead>
                    <tbody>
                      {backups.map((b) => (
                        <tr key={b.id}>
                          <td>{new Date(b.at).toLocaleString(locale)}</td>
                          <td>{size(b.sizeBytes)}</td>
                          <td><button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api(`/apps/${id}/database/restore`, { method: 'POST', body: { backupId: b.id } }), 'db.restored', 'db.restoreConfirm')}>{t('db.restore')}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <h3>{t('db.dangerTitle')}</h3>
          <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api(`/apps/${id}/database`, { method: 'DELETE' }), 'db.removed', 'db.removeConfirm')}>{t('db.remove')}</button>
        </>
      )}
    </section>
  );
}
