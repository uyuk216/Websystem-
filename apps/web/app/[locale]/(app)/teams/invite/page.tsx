import { InviteClient } from './client';

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ i?: string; t?: string }> }) {
  const { i, t } = await searchParams;
  return <InviteClient inviteId={i ?? ''} token={t ?? ''} />;
}
