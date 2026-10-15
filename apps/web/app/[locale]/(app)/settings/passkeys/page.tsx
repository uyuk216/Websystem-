'use client';
import { useState } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useI18n } from '@/lib/i18n';
import { registerPasskey } from '@/lib/passkey';

export default function PasskeysPage() {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'ok' | 'failed' | 'unsupported'>('idle');

  async function add() {
    if (!browserSupportsWebAuthn()) return setState('unsupported');
    try {
      await registerPasskey();
      setState('ok');
    } catch {
      setState('failed');
    }
  }

  return (
    <>
      <h1>{t('passkeys.title')}</h1>
      {state === 'ok' && <p role="status">{t('passkeys.added')}</p>}
      {state === 'failed' && <p role="alert" className="error">{t('passkeys.failed')}</p>}
      {state === 'unsupported' && <p role="alert" className="error">{t('passkeys.unsupported')}</p>}
      <button type="button" onClick={() => void add()}>{t('passkeys.add')}</button>
    </>
  );
}
