import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/supabase/server';

/**
 * Root. There is no marketing site in this repo — the platform's front door is the
 * dashboard — so this is purely a fork on whether the visitor is signed in.
 */
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? '/app' : '/login');
}
