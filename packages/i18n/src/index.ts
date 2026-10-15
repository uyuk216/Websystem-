import { en } from './en.js';
import { ja } from './ja.js';

export type Locale = 'ja' | 'en';
export type MessageKey = keyof typeof ja;

const catalogs: Record<Locale, Record<MessageKey, string>> = { ja, en };

/**
 * Looks up a message and replaces `{name}` placeholders with params.
 * Placeholders without a matching param are left intact.
 */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = catalogs[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}
