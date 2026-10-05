import { redirect } from 'next/navigation';
import { createClient } from '../../../lib/supabase/server';
import InviteAccept from './invite-accept';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth?next=' + encodeURIComponent('/invite/' + token));

  return <main className="shell"><section className="invite-page"><InviteAccept token={token} /></section></main>;
}
