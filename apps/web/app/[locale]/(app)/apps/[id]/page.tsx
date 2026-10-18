'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';
import { siteUrl } from '@/lib/site';
import type { MessageKey } from 'i18n';
import { DynamicPanel } from './dynamic-panel';
import { DatabasePanel } from './database-panel';

interface AppInfo { id: string; name: string; kind: 'static' | 'dynamic'; publishDir: string; activeDeploymentId: string | null; githubRepo: string | null; githubBranch: string | null }
interface Finding { path: string; line: number; rule: string }
interface Dep {
  id: string; status: string; source: string; message: string | null; findings: Finding[] | { kind: 'runtime'; logs: string[] } | null;
  fileCount: number | null; createdAt: string;
}
interface Usage { month: string; bytes: number; limitBytes: number }

const PENDING = ['queued', 'processing'];
const statusKey = (s: string) => `deploy.status.${s}` as MessageKey;

export default function AppPage() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [deps, setDeps] = useState<Dep[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedDir, setSavedDir] = useState(false);
  const [savedGithub, setSavedGithub] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rbFail, setRbFail] = useState<{ reason: string; logs: string[] } | null>(null);
  const [publishDir, setPublishDir] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [installationId, setInstallationId] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const fail = useCallback((err: unknown) => setError(t(err instanceof ApiError ? errorKey(err.code) : 'common.error')), [t]);
  const loadDeps = useCallback(() => api<{ deployments: Dep[] }>(`/apps/${id}/deployments`).then((r) => setDeps(r.deployments)).catch(fail), [id, fail]);
  const loadApp = useCallback(() => api<AppInfo>(`/apps/${id}`).then((a) => setApp(a)).catch(fail), [id, fail]);

  useEffect(() => {
    void loadApp(); void loadDeps();
    api<Usage>(`/apps/${id}/usage`).then(setUsage).catch(() => undefined);
  }, [id, loadApp, loadDeps]);
  useEffect(() => {
    if (app) { setPublishDir(app.publishDir); setRepo(app.githubRepo ?? ''); setBranch(app.githubBranch ?? 'main'); }
  }, [app?.id]);

  // Queued/processing deployments refresh every 2 seconds until they settle.
  const pending = deps?.some((d) => PENDING.includes(d.status)) ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => { void loadDeps(); void loadApp(); }, 2000);
    return () => clearInterval(timer);
  }, [pending, loadDeps, loadApp]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const f = file.current?.files?.[0];
    if (!f) return;
    const body = new FormData();
    body.append('file', f);
    setUploading(true);
    try {
      const res = await fetch(`/api/apps/${id}/deployments`, { method: 'POST', body });
      if (res.status === 401) { window.location.href = `/${locale}/login`; return; }
      if (!res.ok) {
        // A 413 may come from a proxy without our JSON body, so the status decides.
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(t(res.status === 413 ? 'deploy.upload.tooLarge' : errorKey(d.error ?? 'error')));
        return;
      }
      if (file.current) file.current.value = '';
      await loadDeps();
    } catch {
      setError(t('common.error'));
    } finally {
      setUploading(false);
    }
  }

  async function rollback(did: string) {
    setError(null); setRbFail(null);
    try { await api(`/apps/${id}/deployments/${did}/rollback`, { method: 'POST' }); await Promise.all([loadDeps(), loadApp()]); } catch (err) {
      if (err instanceof ApiError && err.code === 'start_failed') {
        const { reason, logs } = err.body as { reason?: unknown; logs?: unknown };
        setRbFail({ reason: typeof reason === 'string' ? reason : 'deploy.error.health_check_failed', logs: Array.isArray(logs) ? logs.map(String) : [] });
      } else fail(err);
    }
  }

  async function savePublishDir(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSavedDir(false);
    try { await api(`/apps/${id}`, { method: 'PATCH', body: { publishDir } }); setSavedDir(true); } catch (err) { fail(err); }
  }

  async function saveGithub(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSavedGithub(false);
    if (!/^\d{1,15}$/.test(installationId)) { setError(t('github.installationInvalid')); return; }
    try {
      await api(`/apps/${id}/github`, { method: 'PATCH', body: { repo, branch, installationId: Number(installationId) } });
      setSavedGithub(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError(t('github.connectFirst')); else fail(err);
    }
  }

  async function remove() {
    if (!window.confirm(t('apps.deleteConfirm'))) return;
    try { await api(`/apps/${id}`, { method: 'DELETE' }); window.location.href = `/${locale}/apps`; } catch (err) { fail(err); }
  }

  if (!app) return error ? <p role="alert" className="error">{error}</p> : <p role="status">{t('common.loading')}</p>;
  const url = siteUrl(app.name);
  return (
    <>
      <h1>{app.name}</h1>
      {error && <p role="alert" className="error">{error}</p>}
      <p>{t('apps.siteUrl')}: <a href={url} data-testid="site-url" target="_blank" rel="noreferrer">{url}</a></p>
      {app.kind === 'dynamic' && <DynamicPanel id={app.id} active={app.activeDeploymentId !== null} statusLabel={t(app.activeDeploymentId ? 'deploy.status.live' : 'dyn.status.none')} />}
      {app.kind === 'dynamic' && <DatabasePanel id={app.id} />}
      {app.kind !== 'dynamic' && usage && <p className="muted">{t('apps.usage')}: {(usage.bytes / 1048576).toFixed(1)} / {(usage.limitBytes / 1048576).toFixed(0)} MB</p>}

      <h2>{t('deploy.upload')}</h2>
      <form className="box" onSubmit={(e) => void upload(e)}>
        <label htmlFor="zf">{t('deploy.file')}</label>
        <input id="zf" ref={file} type="file" accept=".zip,application/zip" required />
        <button type="submit" disabled={uploading}>{t('deploy.upload')}</button>
      </form>

      {rbFail && (
        <div role="alert">
          <p>{t(rbFail.reason.startsWith('deploy.') ? (rbFail.reason as MessageKey) : 'deploy.error.health_check_failed')}</p>
          {rbFail.logs.length > 0 && <pre data-testid="rollback-log">{rbFail.logs.join('\n')}</pre>}
        </div>
      )}
      <h2>{t('deploy.title')}</h2>
      {deps?.length === 0 && <p className="blankslate">{t('deploy.empty')}</p>}
      {deps && deps.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th scope="col">{t('deploy.createdAt')}</th><th scope="col">{t('deploy.source')}</th><th scope="col" /><th scope="col" /></tr></thead>
            <tbody>
              {deps.map((d) => (
                <tr key={d.id} data-status={d.status}>
                  <td>{new Date(d.createdAt).toLocaleString(locale)}</td>
                  <td>{d.source}{d.fileCount != null && <> ({t('deploy.files', { n: d.fileCount })})</>}</td>
                  <td>
                    <strong data-testid="status">{t(statusKey(d.status))}</strong>
                    {d.status === 'blocked_secret' && (
                      <div role="note">
                        <p>{t('deploy.blockedHelp')}</p>
                        <ul>{(Array.isArray(d.findings) ? d.findings : []).map((f, i) => <li key={i}><code>{f.path}:{f.line}</code> ({f.rule})</li>)}</ul>
                      </div>
                    )}
                    {d.status === 'held_for_review' && <p role="note">{t('deploy.heldHelp')}</p>}
                    {d.status === 'failed' && d.message && <p className="muted">{d.message.startsWith('deploy.') ? t(d.message as MessageKey) : d.message}</p>}
                    {d.status === 'failed' && d.findings && !Array.isArray(d.findings) && d.findings.logs.length > 0 && (
                      <pre data-testid="runtime-log">{d.findings.logs.join('\n')}</pre>
                    )}
                  </td>
                  <td>{d.status === 'superseded' && <button type="button" onClick={() => void rollback(d.id)}>{t('deploy.rollback')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {app.kind !== 'dynamic' && <h2>{t('apps.publishDir')}</h2>}
      {app.kind !== 'dynamic' && <form className="box" onSubmit={(e) => void savePublishDir(e)}>
        <p className="muted">{t('apps.publishDirHelp')}</p>
        <label htmlFor="pd">{t('apps.publishDirLabel')}</label>
        <input id="pd" value={publishDir} maxLength={200} onChange={(e) => setPublishDir(e.target.value)} />
        <button type="submit">{t('apps.save')}</button>
        {savedDir && <span role="status">{t('apps.saved')}</span>}
      </form>}

      <h2>{t('github.title')}</h2>
      <form className="box" onSubmit={(e) => void saveGithub(e)} data-testid="github-form">
        <label htmlFor="gr">{t('github.repo')}</label>
        <input id="gr" value={repo} onChange={(e) => setRepo(e.target.value)} required />
        <label htmlFor="gb">{t('github.branch')}</label>
        <input id="gb" value={branch} onChange={(e) => setBranch(e.target.value)} required />
        <label htmlFor="gi">{t('github.installation')}</label>
        <input id="gi" inputMode="numeric" pattern="[0-9]*" value={installationId} onChange={(e) => setInstallationId(e.target.value.replace(/\D/g, ''))} required />
        <button type="submit">{t('github.save')}</button>
        {savedGithub && <span role="status">{t('apps.saved')}</span>}
      </form>

      <button type="button" className="secondary" onClick={() => void remove()}>{t('apps.delete')}</button>
    </>
  );
}
