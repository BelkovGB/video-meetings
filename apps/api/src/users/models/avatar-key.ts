import { createHmac, randomBytes } from 'node:crypto';

/**
 * Random per process and never persisted. The key it derives exists only so a
 * client can tell that two responses carry the same avatar; it must not be
 * linkable to the user, so it may not be reversible, guessable, or comparable
 * across scopes or across restarts.
 */
const keyingMaterial = randomBytes(32);

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
