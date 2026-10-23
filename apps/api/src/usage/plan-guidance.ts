import { t, type Locale } from 'i18n';
import type { Db } from '../db/client.js';
import { resolveEntitlements } from '../grants/entitlements.js';

export async function planGuidance(db: Db, ownerId: string, locale: Locale): Promise<string> {
  const { plan } = await resolveEntitlements(db, ownerId);
  return t(locale, `plan.help.${plan}`);
}
