import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Server-only client. The secret key bypasses Row Level Security, so this
// module must never be imported by anything that ships to a browser.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});