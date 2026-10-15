'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { errorKey, useI18n } from '@/lib/i18n';

export function InviteClient({ inviteId, token }: { inviteId: string; token: string }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<'idle' | 'done' | string>('idle');

  async function accept() {
    try {
      await api('/teams/invites/accept', { method: 'POST', body: { inviteId, token } });
      setState('done');
    } catch (e) { setState(e instanceof ApiError && (e.code === 'invalid' || e.code === 'expired') ? t('teams.inviteInvalid') : t(e instanceof ApiError ? errorKey(e.code) : 'common.error')); }
  }

  return (
    <>
      <h1>{t('teams.acceptTitle')}</h1>
      {state === 'done' ? <p role="status">{t('teams.accepted')} <Link href={`/${locale}/teams`}>{t('teams.back')}</Link></p> : (
        <>
          {state !== 'idle' && <p role="alert" className="error">{state}</p>}
          <button type="button" onClick={() => void accept()}>{t('teams.accept')}</button>
        </>
      )}
    </>
  );
}
