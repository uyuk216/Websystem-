import type { ja } from './ja.js';

export const en = {
  'login.codeSent': 'We sent a verification code to {email}.',
  'login.codeInvalid': 'The verification code is incorrect.',
  'age.under13': 'Users under 13 cannot use this service.',
  'age.invalid': 'The birth date is not valid.',
} satisfies Record<keyof typeof ja, string>;
