import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { publicEnv } from '@atwood/core';

/**
 * Request-scoped Supabase client for server components and route handlers.
 *
 * This client carries the **user's** JWT, so every query it makes is filtered by
 * RLS. That is the point: the dashboard never needs to remember to add
 * `.eq('business_id', …)`, because the database refuses to return anything else.
 *
 * The service-role client (`getAdminClient()` in @atwood/core) is the opposite —
 * it bypasses RLS and is only for the internal API and webhook handlers. Reaching
 * for it in a page or a dashboard route would silently discard tenant isolation.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies. The middleware refreshes the
          // session on every request, so failing quietly here is correct rather
          // than merely convenient.
        }
      },
    },
  });
}

/**
 * The signed-in user, or null.
 *
 * Uses `getUser()` rather than `getSession()`: `getSession()` reads the cookie
 * without verifying it, so it will happily report a user from a forged or expired
 * token. `getUser()` validates against the auth server. For anything that gates
 * access, that distinction matters.
 */
export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;
  return user;
}
