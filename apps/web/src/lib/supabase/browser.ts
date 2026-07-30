'use client';

import { createBrowserClient } from '@supabase/ssr';

import { publicEnv } from '@atwood/core';

/**
 * Browser Supabase client.
 *
 * Uses the anon key, which is safe to ship because every table is behind RLS —
 * the key identifies the project, it does not grant access. All authority comes
 * from the user's JWT.
 *
 * Used for realtime subscriptions (the conversation viewer updating live as an SMS
 * arrives) and for auth. Data fetching happens in server components, where it can
 * be rendered without a round trip.
 */
let cached: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  cached ??= createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
  return cached;
}
