import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabase/server';

function safeDestination(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const destination = safeDestination(url.searchParams.get('next'));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(destination, request.url));
  }

  return NextResponse.redirect(new URL('/auth?error=callback&next=' + encodeURIComponent(destination), request.url));
}
