import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { publicEnv, serverEnv } from '../env.ts';

/**
 * The service-role Supabase client.
 *
 * **This client bypasses RLS.** Every query it makes must therefore filter by
 * `business_id` explicitly — the database will not do it for you here. That is the
 * trade: n8n and the internal API need to act across tenants (routing an inbound
 * number to whichever tenant owns it), and RLS cannot express that, so isolation
 * moves into code for exactly these call sites and nowhere else.
 *
 * Rules for using it:
 *   * Never import this into a client component or anything the browser bundles.
 *     `serverEnv` throws if evaluated in a browser, which is the backstop.
 *   * Always take `businessId` from a trusted source (the resolved phone number,
 *     or an authenticated session), never from request input.
 *   * Prefer the RPC functions in migration 0009 over multi-step table writes;
 *     they are transactional and idempotent.
 */
let cached: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(publicEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
    auth: {
      // A service client has no user session to persist or refresh, and leaving
      // these on causes spurious token refresh traffic in serverless runtimes.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        // Shows up in Supabase's logs, which makes it possible to tell API traffic
        // apart from dashboard traffic when something goes wrong.
        'x-application-name': 'atwood-internal-api',
      },
    },
  });

  return cached;
}

/**
 * Wrap a Supabase result, throwing on error.
 *
 * Supabase returns `{ data, error }` rather than throwing, which is ergonomic
 * until a forgotten `if (error)` silently turns a failed insert into a successful
 * request. This makes the failure loud.
 */
export function unwrap<T>(result: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (result.error) {
    throw new Error(`${what} failed: ${result.error.message}${result.error.code ? ` (${result.error.code})` : ''}`);
  }
  if (result.data === null) {
    throw new Error(`${what} returned no data`);
  }
  return result.data;
}

/** As `unwrap`, but a missing row is a legitimate `null` rather than an error. */
export function unwrapMaybe<T>(result: {
  data: T | null;
  error: { message: string; code?: string } | null;
}, what: string): T | null {
  if (result.error) {
    // PGRST116 is "no rows returned" from .single(); that is not a fault here.
    if (result.error.code === 'PGRST116') return null;
    throw new Error(`${what} failed: ${result.error.message}`);
  }
  return result.data;
}
