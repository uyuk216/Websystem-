import { t } from 'i18n';

/** Signed-out pages: one narrow card in the middle of the page. */
export default async function AuthLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <div className="auth-shell">
      <p className="auth-brand">{t(locale === 'en' ? 'en' : 'ja', 'app.name')}</p>
      <main className="auth-card">{children}</main>
    </div>
  );
}
