import { createBrowserClient, type SupabaseClient } from '@supabase/ssr';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  'https://lzogiorclfpmibqmzugg.supabase.co';

const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  'sb_publishable_iBHwya4WH4QhYiMZGFuArw_mZtzSuwd';

let browserClient: SupabaseClient | null = null;

export function createClient() {
  if (!browserClient) browserClient = createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return browserClient;
}
