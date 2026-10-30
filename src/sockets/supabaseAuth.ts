import { supabase } from '../lib/supabase.js';
import type { RoomRepo } from '../rooms/roomRepo.js';
import type { Authenticator } from './auth.js';

/**
 * Verifies the Supabase access token by asking Supabase Auth, then loads the user's username.
 * The browser gets the token from supabase.auth.getSession().
 */
export function createSupabaseAuthenticator(repo: Pick<RoomRepo, 'getProfile'>): Authenticator {
  return async (token) => {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    const profile = await repo.getProfile(data.user.id);
    if (!profile) return null; // the sign-up trigger creates profiles, so this means a broken setup
    return { id: data.user.id, username: profile.username };
  };
}
