import { ConfirmClient } from './client';

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ c?: string; s?: string }> }) {
  const { c, s } = await searchParams;
  return <ConfirmClient c={c ?? ''} s={s ?? ''} />;
}
