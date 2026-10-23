'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { MessageKey } from 'i18n';

interface Boost { id: string; eventName: string; startsAt: string; endsAt: string; expectedVisits: number; status: 'requested' | 'approved' | 'rejected'; rejectReason: string | null }

export default function BoostPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Boost[] | null>(null);
  const [form, setForm] = useState({ eventName: '', startsAt: '', endsAt: '', expectedVisits: '1000' });
  const [error, setError] = useState<MessageKey | null>(null);
  const [sent, setSent] = useState(false);
  const load = useCallback(() => api<{ boosts: Boost[] }>(`/apps/${id}/boosts`).then((r) => setRows(r.boosts)).catch(() => setError('common.error')), [id]);
  useEffect(() => { void load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(false);
    try {
      await api(`/apps/${id}/boosts`, {
        method: 'POST',
        body: { eventName: form.eventName, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(), expectedVisits: Number(form.expectedVisits) },
      });
      setSent(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? (`boost.error.${err.code}` as MessageKey) : 'common.error');
    }
  }

  return (
    <>
      <h1>{t('boost.title')}</h1>
      <p>{t('boost.lead')}</p>
      {sent && <p role="status">{t('boost.sent')}</p>}
      {error && <p role="alert" className="error">{t(error)}</p>}
      <form className="box" onSubmit={(e) => void submit(e)}>
        <label htmlFor="be">{t('boost.eventName')}</label>
        <input id="be" required maxLength={100} value={form.eventName} onChange={(e) => setForm({ ...form, eventName: e.target.value })} />
        <label htmlFor="bs">{t('boost.startsAt')}</label>
        <input id="bs" type="datetime-local" required value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
        <label htmlFor="bn">{t('boost.endsAt')}</label>
        <input id="bn" type="datetime-local" required value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
        <label htmlFor="bv">{t('boost.visits')}</label>
        <input id="bv" type="number" min={0} required value={form.expectedVisits} onChange={(e) => setForm({ ...form, expectedVisits: e.target.value })} />
        <button type="submit">{t('boost.submit')}</button>
      </form>
      {rows && rows.length > 0 && (
        <ul>
          {rows.map((b) => (
            <li key={b.id}>
              {b.eventName}: {new Date(b.startsAt).toLocaleString(locale)} - {new Date(b.endsAt).toLocaleString(locale)} ({t(`boost.status.${b.status}` as MessageKey)}{b.rejectReason ? `: ${b.rejectReason}` : ''})
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
