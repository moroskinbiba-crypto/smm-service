import { NextResponse, type NextRequest } from 'next/server';

function isPublicPath(path: string) {
  return path === '/health'
    || path === '/auth'
    || path.startsWith('/auth/')
    || path === '/invite'
    || path.startsWith('/invite/');
}

function hasSupabaseAuthCookie(request: NextRequest) {
  return request.cookies.getAll().some(cookie => cookie.name.startsWith('sb-'));
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Public routes must never wait on Supabase.
  if (isPublicPath(path)) {
    return NextResponse.next();
  }

  // Avoid a network round-trip to Supabase on every page request.
  // The Edge Function still verifies the JWT before any protected data is returned.
  if (hasSupabaseAuthCookie(request)) {
    return NextResponse.next();
  }

  return NextResponse.redirect(
    new URL('/auth?next=' + encodeURIComponent(path), request.url),
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
