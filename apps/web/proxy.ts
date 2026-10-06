import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

function isPublicPath(path: string) {
  return path === '/health'
    || path === '/auth'
    || path.startsWith('/auth/')
    || path === '/invite'
    || path.startsWith('/invite/');
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Public routes must never depend on Supabase availability.
  if (isPublicPath(path)) {
    return NextResponse.next();
  }

  const response = NextResponse.next({ request });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // Keep the site renderable even when Vercel env configuration is incomplete.
  // Actual data/API access will still fail closed on the Supabase side.
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.redirect(
      new URL('/auth?error=config&next=' + encodeURIComponent(path), request.url),
    );
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.redirect(
      new URL('/auth?next=' + encodeURIComponent(path), request.url),
    );
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
