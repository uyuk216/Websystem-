import { redirect } from 'next/navigation';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/settings/devices`); // the app shell bounces to /login when there is no session
}
