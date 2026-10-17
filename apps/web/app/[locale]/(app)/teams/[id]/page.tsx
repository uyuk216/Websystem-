'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';
import type { MessageKey } from 'i18n';

interface Team { id: string; name: string; role: string; members: { accountId: string; role: string; displayName: string }[] }
const roleKey: Record<string, MessageKey> = { owner: 'teams.owner', admin: 'teams.admin', member: 'teams.member' };

export default function TeamPage() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [team, setTeam] = useState<Team | null>(null);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<Team>(`/teams/${id}`).then(setTeam).catch(() => setMsg({ ok: false, text: t('common.error') })), [id, t]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, okText?: string, after?: () => void) {
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ ok: true, text: okText });
      if (after) after(); else await load();
    } catch (e) { setMsg({ ok: false, text: t(e instanceof ApiError ? errorKey(e.code) : 'common.error') }); }
  }
  const toList = () => router.push(`/${locale}/teams`);
  const canManage = team?.role === 'owner' || team?.role === 'admin';
  const isOwner = team?.role === 'owner';

  if (!team) return <>{msg && <p role="alert" className="error">{msg.text}</p>}<Link href={`/${locale}/teams`}>{t('teams.back')}</Link></>;
  return (
    <>
      <p><Link href={`/${locale}/teams`}>{t('teams.back')}</Link></p>
      <h1>{team.name}</h1>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? undefined : 'error'}>{msg.text}</p>}
      <h2>{t('teams.members')}</h2>
      <div className="scroll">
        <table>
          <tbody>
            {team.members.map((m) => (
              <tr key={m.accountId}>
                <th scope="row">{m.displayName}</th>
                <td>{t(roleKey[m.role] ?? 'teams.member')}</td>
                <td>
                  {isOwner && m.role === 'member' && <button type="button" className="secondary" onClick={() => void run(() => api(`/teams/${id}/members/${m.accountId}`, { method: 'PATCH', body: { role: 'admin' } }))}>{t('teams.makeAdmin')}</button>}
                  {isOwner && m.role === 'admin' && <button type="button" className="secondary" onClick={() => void run(() => api(`/teams/${id}/members/${m.accountId}`, { method: 'PATCH', body: { role: 'member' } }))}>{t('teams.makeMember')}</button>}
                  {isOwner && m.role !== 'owner' && <button type="button" className="secondary" onClick={() => void run(() => api(`/teams/${id}/transfer`, { method: 'POST', body: { toAccountId: m.accountId } }))}>{t('teams.transfer')}</button>}
                  {canManage && m.role !== 'owner' && <button type="button" className="secondary" onClick={() => void run(() => api(`/teams/${id}/members/${m.accountId}`, { method: 'DELETE' }))}>{t('teams.remove')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage && (
        <form className="box" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/teams/${id}/invites`, { method: 'POST', body: { email } }), t('teams.invited'), () => setEmail('')); }}>
          <label htmlFor="ie">{t('teams.inviteEmail')}</label>
          <input id="ie" type="email" name="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit">{t('teams.invite')}</button>
        </form>
      )}
      <p>
        <button type="button" className="secondary" onClick={() => void run(() => api(`/teams/${id}/leave`, { method: 'POST' }), undefined, toList)}>{t('teams.leave')}</button>
        {isOwner && <button type="button" className="secondary" onClick={() => { if (window.confirm(t('teams.confirmDelete'))) void run(() => api(`/teams/${id}`, { method: 'DELETE' }), undefined, toList); }}>{t('teams.delete')}</button>}
      </p>
    </>
  );
}
