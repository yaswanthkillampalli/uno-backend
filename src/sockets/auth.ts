import type { AuthUser } from '../rooms/types.js';

/** Turns an access token into a user, or null if it is not valid. */
export type Authenticator = (token: string) => Promise<AuthUser | null>;
