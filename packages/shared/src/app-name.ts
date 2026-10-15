import { RESERVED_APP_NAMES } from './reserved-names.js';

export const APP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export type AppNameCheck = { ok: true } | { ok: false; reason: 'format' | 'reserved' };

/** 3-32 chars of a-z, 0-9 and hyphen; no leading/trailing hyphen, no "--"; not reserved. */
export function validateAppName(name: string): AppNameCheck {
  if (typeof name !== 'string' || !APP_NAME_RE.test(name) || name.includes('--')) return { ok: false, reason: 'format' };
  if (RESERVED_APP_NAMES.has(name)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}
