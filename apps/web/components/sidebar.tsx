'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MessageKey } from 'i18n';
import { useI18n } from '@/lib/i18n';

type IconName = 'apps' | 'teams' | 'key' | 'device' | 'history' | 'passkey';

export interface NavItem { href: string; label: MessageKey; icon: IconName }
export interface NavGroup { label: MessageKey; items: NavItem[] }

/** The whole menu; the sidebar and the breadcrumb both read from here so they never disagree. */
export const NAV: NavGroup[] = [
  { label: 'nav.groupMain', items: [
    { href: '/apps', label: 'nav.apps', icon: 'apps' },
    { href: '/teams', label: 'nav.teams', icon: 'teams' },
  ] },
  { label: 'nav.groupAccount', items: [
    { href: '/settings/tokens', label: 'nav.tokens', icon: 'key' },
    { href: '/settings/devices', label: 'nav.devices', icon: 'device' },
    { href: '/settings/logins', label: 'nav.logins', icon: 'history' },
    { href: '/settings/passkeys', label: 'nav.passkeys', icon: 'passkey' },
  ] },
];

/** The menu entry the current path belongs to (e.g. /ja/apps/123 → Apps), with its group. */
export function findCurrent(pathname: string, locale: string): { group: NavGroup; item: NavItem; isTop: boolean } | null {
  const rest = pathname.slice(`/${locale}`.length) || '/';
  for (const group of NAV) {
    for (const item of group.items) {
      if (rest === item.href) return { group, item, isTop: true };
      if (rest.startsWith(`${item.href}/`)) return { group, item, isTop: false };
    }
  }
  return null;
}

const PATHS: Record<IconName, string> = {
  apps: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  teams: 'M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1.5 13c0-2.2 1.8-4 4-4s4 1.8 4 4M11 7a1.75 1.75 0 1 0 0-3.5M11.5 9.2c1.7.4 3 1.9 3 3.8',
  key: 'M10 2.5a3.5 3.5 0 1 1-2.9 5.5L2.5 12.5V14h2v-1.5h1.5V11h1.5l.9-.9A3.5 3.5 0 0 1 10 2.5zM11 5h.01',
  device: 'M2.5 3.5h11v7h-11zM6 13.5h4M8 10.5v3',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3.2l2 1.3',
  passkey: 'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c0-2.5 2-4.5 4.5-4.5 1 0 1.9.3 2.6.8M12 9v5M10.5 12.5l1.5 1.5 1.5-1.5M12 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const current = findCurrent(pathname, locale);
  return (
    <aside className="sidebar">
      <Link href={`/${locale}/apps`} className="brand">{t('app.name')}</Link>
      <nav aria-label={t('nav.label')}>
        {NAV.map((group) => (
          <div key={group.label} className="nav-group">
            <h2 className="nav-heading">{t(group.label)}</h2>
            <ul>
              {group.items.map((item) => {
                const active = current?.item === item;
                return (
                  <li key={item.href}>
                    <Link href={`/${locale}${item.href}`} aria-current={active ? 'page' : undefined} className={active ? 'active' : undefined}>
                      <Icon name={item.icon} />
                      <span>{t(item.label)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <button type="button" className="logout" onClick={onLogout}>{t('nav.logout')}</button>
    </aside>
  );
}

/** "Account settings › Passkeys"; on a detail page the menu entry links back to its list. */
export function Breadcrumb() {
  const { t, locale } = useI18n();
  const current = findCurrent(usePathname(), locale);
  if (!current) return null;
  return (
    <nav className="breadcrumb" aria-label={t('nav.breadcrumb')}>
      <span>{t(current.group.label)}</span>
      <span aria-hidden="true">/</span>
      {current.isTop
        ? <span aria-current="page">{t(current.item.label)}</span>
        : <Link href={`/${locale}${current.item.href}`}>{t(current.item.label)}</Link>}
    </nav>
  );
}
