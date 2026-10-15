import { LinkClient } from './client';

export default async function LinkPage({ searchParams }: { searchParams: Promise<{ c?: string; t?: string }> }) {
  const { c, t } = await searchParams;
  return <LinkClient c={c ?? ''} token={t ?? ''} />;
}
