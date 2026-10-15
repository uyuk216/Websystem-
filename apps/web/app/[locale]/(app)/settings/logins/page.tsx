'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { MessageKey } from 'i18n';

interface Ev { id: string; method: string; deviceLabel: string; region: string | null; ipPrefix: string; createdAt: string }
const methodKey: Record<string, MessageKey> = { email: 'logins.methodEmail', passkey: 'logins.methodPasskey', recovery: 'logins.methodRecovery' };

export default function LoginsPage() {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Ev[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { api<{ events: Ev[] }>('/me/logins').then((r) => setRows(r.events)).catch(() => setError(true)); }, []);

  return (
    <>
      <h1>{t('logins.title')}</h1>
      {error && <p role="alert" className="error">{t('common.error')}</p>}
      {rows?.length === 0 && <p>{t('logins.empty')}</p>}
      {rows && rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th scope="col">{t('logins.when')}</th><th scope="col">{t('logins.method')}</th><th scope="col">{t('logins.device')}</th><th scope="col">{t('logins.region')}</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleString(locale)}</td>
                  <td>{methodKey[e.method] ? t(methodKey[e.method]!) : e.method}</td>
                  <td>{e.deviceLabel}</td>
                  <td>{e.region ?? e.ipPrefix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
