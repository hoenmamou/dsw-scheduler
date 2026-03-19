import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// debug log to verify env vars are seen at runtime
if (typeof window !== 'undefined') {
  console.debug('supabase env', { SUPABASE_URL, keyLen: SUPABASE_ANON_KEY?.length, configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY) });
} else {
  // server side log as well
  console.debug('supabase env (server)', { SUPABASE_URL, keyLen: SUPABASE_ANON_KEY?.length, configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY) });
}

export const SUPABASE_CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = SUPABASE_CONFIGURED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;