import { OAuth2Client } from 'google-auth-library';
import { HubError } from '../lib/errors.js';

export interface GoogleProfile {
  /** Google's stable account id. */
  sub: string;
  /** Verified, lowercased. */
  email: string;
  name: string;
}

/** Verifies a Google Identity Services credential (an ID token). Injectable for tests. */
export type GoogleVerifier = (idToken: string) => Promise<GoogleProfile>;

/**
 * Verifies against Google's keys with `clientId` as the audience and requires a verified email.
 * `devBypass` (local Mongo only, see config) also accepts "dev:<email>" so local runs need no OAuth client.
 */
export function googleVerifier(clientId: string | undefined, devBypass = false): GoogleVerifier {
  const client = clientId ? new OAuth2Client(clientId) : undefined;
  return async (idToken) => {
    if (devBypass && idToken.startsWith('dev:')) {
      const email = idToken.slice(4).trim().toLowerCase();
      return { sub: `dev:${email}`, email, name: email.split('@')[0] ?? email };
    }
    if (!client) throw new HubError('unsupported', 'Google sign-in is not configured on this hub (GOOGLE_CLIENT_ID is unset)');
    let payload;
    try {
      payload = (await client.verifyIdToken({ idToken, audience: clientId })).getPayload();
    } catch {
      throw new HubError('unauthorized', 'Google sign-in failed: the credential is invalid or expired');
    }
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new HubError('unauthorized', 'Google sign-in failed: the account has no verified email');
    }
    return { sub: payload.sub, email: payload.email.toLowerCase(), name: payload.name ?? payload.email.split('@')[0]! };
  };
}
