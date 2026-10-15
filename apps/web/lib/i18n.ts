'use client';
import { useCallback } from 'react';
import { useParams } from 'next/navigation';
import { t as translate, type Locale, type MessageKey } from 'i18n';

export function useI18n() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = params.locale === 'en' ? 'en' : 'ja';
  const t = useCallback((key: MessageKey, p?: Record<string, string | number>) => translate(locale, key, p), [locale]);
  return { locale, t };
}

/** Maps an API error code to a translated message. */
export function errorKey(code: string): MessageKey {
  switch (code) {
    case 'rate_limited': return 'common.rateLimited';
    case 'forbidden': return 'teams.forbidden';
    case 'full': return 'teams.full';
    case 'last_owner': return 'teams.lastOwner';
    case 'invalid': return 'common.invalid';
    default: return 'common.error';
  }
}
