import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Auth middleware.
 *
 * Does two things, and deliberately not a third:
 *
 *  1. Refreshes the Supabase session cookie. Access tokens are short-lived; without
 *     a refresh on each request the user is logged out mid-session.
 *  2. Redirects unauthenticated users away from `/app`.
 *
 * It does **not** check whether the user is a member of the business in the URL.
 * That check belongs to RLS, which enforces it for every query rather than only on
 * navigation — a membership check here would be a second, weaker copy of a rule the
 * database already applies, and the kind of duplication that drifts.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const supabaseAnonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];

  // Without configuration there is no session to refresh. Failing open here is
  // safe: every protected route re-checks the user, and RLS backs that up.
  if (!supabaseUrl || !supabaseAnonKey) return response;

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user && path.startsWith('/app')) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    // Preserve where they were heading so login can return them there.
    login.searchParams.set('next', path);
    return NextResponse.redirect(login);
  }

  if (user && (path === '/login' || path === '/signup')) {
    const app = request.nextUrl.clone();
    app.pathname = '/app';
    app.search = '';
    return NextResponse.redirect(app);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the API.
     *
     * The API is excluded on purpose: webhook and internal routes authenticate with
     * a Twilio signature or a shared secret, not a cookie, and running cookie
     * middleware over them would add a pointless auth round trip to the hot path.
     */
    '/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
