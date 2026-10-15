import type { ja } from './ja.js';

export const en = {
  'login.codeSent': 'We sent a verification code to {email}.',
  'login.codeInvalid': 'The verification code is incorrect.',
  'age.under13': 'Users under 13 cannot use this service.',
  'age.invalid': 'The birth date is not valid.',
  'recovery.adminSubject': '[Admin] Recovery request received',
  'recovery.adminBody': 'A recovery request was received. Request ID: {requestId}\nAfter verifying, run: pnpm --filter api admin:approve-recovery {requestId}',
  'recovery.approvedSubject': 'Your recovery request was approved',
  'recovery.approvedBody': 'Your recovery request was approved. All previous sign-ins and passkeys have been revoked. Log in with your email address and set up a passkey again. Your new recovery code will be given to you separately by the administrator.',
} satisfies Record<keyof typeof ja, string>;
