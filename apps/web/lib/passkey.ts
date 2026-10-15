import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { api } from './api';

export async function registerPasskey(): Promise<void> {
  const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/auth/passkey/register/start', { method: 'POST' });
  const response = await startRegistration({ optionsJSON: options });
  await api('/auth/passkey/register/finish', { method: 'POST', body: { challengeId, response } });
}
