import { notFound } from 'next/navigation';
import { t } from 'i18n';
import '../globals.css';

export function generateStaticParams() {
  return [{ locale: 'ja' }, { locale: 'en' }];
}

export default async function RootLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== 'ja' && locale !== 'en') notFound();
  return (
    <html lang={locale}>
      <head><title>{t(locale, 'app.name')}</title></head>
      <body>{children}</body>
    </html>
  );
}
