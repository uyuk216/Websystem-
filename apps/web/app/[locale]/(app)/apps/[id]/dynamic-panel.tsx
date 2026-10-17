'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';
import type { MessageKey } from 'i18n';

interface EnvVar { name: string; updatedAt: string }
interface AccessRow { at: string; method: string; path: string; status: number; bytes: number }
interface Period { period: string; minutes: number; limitMinutes: number }
interface Usage { bytes: number; limitBytes: number; runtime?: { month: Period; fiscalYear: Period } }

const hours = (m: number): string => (m / 60).toFixed(1);

/** Dynamic-app management: env vars (names only), logs, access logs, usage and restart. All values render as text. */
export function DynamicPanel({ id, active, statusLabel }: { id: string; active: boolean; statusLabel: string }) {
  const { t, locale } = useI18n();
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [access, setAccess] = useState<AccessRow[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failLogs, setFailLogs] = useState<string[]>([]);
  const [restarting, setRestarting] = useState(false);

  const fail = useCallback((err: unknown) => setError(t(err instanceof ApiError ? errorKey(err.code) : 'common.error')), [t]);
  const loadEnv = useCallback(() => api<{ vars: EnvVar[] }>(`/apps/${id}/env`).then((r) => setVars(r.vars)).catch(fail), [id, fail]);
  const loadLogs = useCallback(() => api<{ lines: string[] }>(`/apps/${id}/logs`).then((r) => setLines(r.lines)).catch(() => setLines([])), [id]);
  useEffect(() => {
    void loadEnv(); void loadLogs();
    api<{ logs: AccessRow[] }>(`/apps/${id}/access-logs`).then((r) => setAccess(r.logs)).catch(() => setAccess([]));
    api<Usage>(`/apps/${id}/usage`).then(setUsage).catch(() => undefined);
  }, [id, loadEnv, loadLogs]);

  async function setVar(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setMsg(null);
    try {
      await api(`/apps/${id}/env/${encodeURIComponent(name)}`, { method: 'PUT', body: { value } });
      setName(''); setValue(''); setMsg(t('dyn.env.saved'));
      await loadEnv();
    } catch (err) { fail(err); }
  }
  async function delVar(n: string) {
    setError(null); setMsg(null);
    try { await api(`/apps/${id}/env/${encodeURIComponent(n)}`, { method: 'DELETE' }); await loadEnv(); } catch (err) { fail(err); }
  }
  async function restart() {
    if (restarting) return;
    setRestarting(true);
    setError(null); setMsg(null); setFailLogs([]);
    try { await api(`/apps/${id}/restart`, { method: 'POST' }); setMsg(t('dyn.restarted')); await loadLogs(); } catch (err) {
      if (err instanceof ApiError && err.code === 'start_failed') {
        const logs = (err.body as { logs?: unknown }).logs;
        setError(t('dyn.restartFailed')); setFailLogs(Array.isArray(logs) ? logs.map(String) : []);
      } else fail(err);
    } finally { setRestarting(false); }
  }
  const row = (key: MessageKey, p: Period) => <li>{t(key)}: {hours(p.minutes)} / {hours(p.limitMinutes)} h</li>;

  return (
    <section data-testid="dynamic-panel">
      <p>{t('dyn.status')}: <strong data-testid="dyn-status">{statusLabel}</strong></p>
      {error && <p role="alert" className="error">{error}</p>}
      {msg && <p role="status">{msg}</p>}
      {failLogs.length > 0 && <pre>{failLogs.join('\n')}</pre>}

      <h2>{t('dyn.usage.title')}</h2>
      {usage && (
        <ul>
          <li>{t('dyn.usage.transfer')}: {(usage.bytes / 1048576).toFixed(1)} / {(usage.limitBytes / 1048576).toFixed(0)} MB</li>
          {usage.runtime && row('dyn.usage.month', usage.runtime.month)}
          {usage.runtime && row('dyn.usage.fy', usage.runtime.fiscalYear)}
        </ul>
      )}

      <h2>{t('dyn.env.title')}</h2>
      <p className="muted">{t('dyn.env.help')}</p>
      {vars?.length === 0 && <p className="blankslate">{t('dyn.env.empty')}</p>}
      {vars && vars.length > 0 && (
        <div className="scroll">
          <table data-testid="env-list">
            <thead><tr><th scope="col">{t('dyn.env.name')}</th><th scope="col">{t('dyn.env.updatedAt')}</th><th scope="col" /></tr></thead>
            <tbody>
              {vars.map((v) => (
                <tr key={v.name}>
                  <td><code>{v.name}</code></td>
                  <td>{new Date(v.updatedAt).toLocaleString(locale)}</td>
                  <td><button type="button" className="secondary" onClick={() => void delVar(v.name)}>{t('dyn.env.delete')}<span className="sr-only"> {v.name}</span></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="box" onSubmit={(e) => void setVar(e)}>
        <label htmlFor="evn">{t('dyn.env.name')}</label>
        <input id="evn" value={name} maxLength={64} autoComplete="off" required onChange={(e) => setName(e.target.value)} />
        <label htmlFor="evv">{t('dyn.env.value')}</label>
        <input id="evv" type="password" value={value} autoComplete="off" required onChange={(e) => setValue(e.target.value)} />
        <button type="submit">{t('dyn.env.set')}</button>
      </form>
      <button type="button" onClick={() => void restart()} disabled={!active || restarting} aria-busy={restarting}>{t('dyn.restart')}</button>

      <h2>{t('dyn.logs.title')}</h2>
      <button type="button" className="secondary" onClick={() => void loadLogs()}>{t('dyn.logs.refresh')}</button>
      {lines && (lines.length === 0 ? <p className="blankslate">{t('dyn.logs.empty')}</p> : <pre data-testid="app-log">{lines.join('\n')}</pre>)}

      <h2>{t('dyn.access.title')}</h2>
      {access?.length === 0 && <p className="blankslate">{t('dyn.access.empty')}</p>}
      {access && access.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th scope="col">{t('dyn.access.time')}</th><th scope="col">{t('dyn.access.method')}</th><th scope="col">{t('dyn.access.path')}</th><th scope="col">{t('dyn.access.status')}</th><th scope="col">{t('dyn.access.bytes')}</th></tr></thead>
            <tbody>
              {access.map((a, i) => (
                <tr key={i}><td>{new Date(a.at).toLocaleString(locale)}</td><td>{a.method}</td><td>{a.path}</td><td>{a.status}</td><td>{a.bytes}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
