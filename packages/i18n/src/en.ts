import type { ja } from './ja.js';

export const en = {
  'login.codeSent': 'We sent a verification code to {email}.',
  'login.codeInvalid': 'The verification code is incorrect.',
  'age.under13': 'Users under 13 cannot use this service.',
  'age.invalid': 'The birth date is not valid.',
  'login.mailSubject': 'Your verification code',
  'login.mailBody': 'Verification code: {code}\n\nYou can also open this link on the same device (valid for 10 minutes).\n{link}\n\nIf you did not request this, ignore this email.',
  'login.existsSubject': 'You already have an account',
  'login.existsBody': 'An account already exists for this email address. Please log in instead of signing up.\n{origin}\n\nIf you did not request this, ignore this email.',
  'recovery.adminSubject': '[Admin] Recovery request received',
  'recovery.adminBody': 'A recovery request was received. Request ID: {requestId}\nAfter verifying, run: pnpm --filter api admin:approve-recovery {requestId}',
  'recovery.approvedSubject': 'Your recovery request was approved',
  'recovery.approvedBody': 'Your recovery request was approved. All previous sign-ins and passkeys have been revoked. Log in with your email address and set up a passkey again. Your new recovery code will be given to you separately by the administrator.',
} satisfies Record<keyof typeof ja, string>;
