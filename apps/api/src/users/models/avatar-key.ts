import { createHmac } from 'node:crypto';

import { environment } from '../../config/environment';

/**
 * Derived from the configured server secret, and so identical in every API
 * process and across restarts: a client behind a load balancer must recognize
 * one avatar whichever instance answered. The label separates this use of the
 * secret from signing, so a key can never be mistaken for, or replayed as, a
 * token. The key stays unlinkable to the user because it is a MAC of an
 * unguessable secret, not because the secret is short-lived.
 */
const keyingMaterial = createHmac('sha256', environment.jwtSecret).update('avatar-key/v1').digest();

/**
 * An opaque name for one user's avatar inside one scope, so a viewer holding
 * many references to the same avatar can fetch and hold it once. Deriving it
 * from a secret keeps the user ID out of the response, and length-prefixing the
 * scope keeps two scopes from ever producing the same key for different users.
 */
export function deriveAvatarKey(scope: string, userId: string): string {
  return createHmac('sha256', keyingMaterial)
    .update(`${scope.length}:${scope}${userId}`)
    .digest('hex')
    .slice(0, 32);
}
