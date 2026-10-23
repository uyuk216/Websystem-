'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function UsageNotice({ id, near, boost = true }: { id: string; near: boolean; boost?: boolean }) {
  const { t, locale } = useI18n();
  const [guidance, setGuidance] = useState('');
  useEffect(() => {
    if (near) void api<{ guidance: string }>(`/apps/${id}/plan-guidance?locale=${locale}`).then((r) => setGuidance(r.guidance)).catch(() => setGuidance(''));
  }, [id, near, locale]);
  return near ? <p className="notice" role="status">{t('plan.near')} {guidance} <Link href={`/${locale}/plan`}>{t('plan.details')}</Link> {boost && <Link href={`/${locale}/apps/${id}/boost`}>{t('boost.title')}</Link>}</p> : null;
}
