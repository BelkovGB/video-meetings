import { Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { environment } from '../../config/environment';

/**
 * The only user fields shared activity may read to describe a user to another
 * user. Email and every other private profile value stay out, so adding a field
 * here changes what all shared responses expose. `id` is selected but never
 * returned: it only feeds the scoped handle below.
 */
export const userIdentitySelect = {
  id: true,
  displayName: true,
  avatarMimeType: true,
  avatarSizeBytes: true,
  avatarUpdatedAt: true,
} satisfies Prisma.UserSelect;

export type UserIdentityResponse = {
  handle: string;
  displayName: string | null;
  avatar: { updatedAt: Date } | null;
};

type SelectedUser = Prisma.UserGetPayload<{ select: typeof userIdentitySelect }>;

/**
 * Keyed separately from the JWT signing key so a handle can never be confused
 * with, or used to probe, an authentication token.
 */
const userHandleKey = createHmac('sha256', environment.jwtSecret)
  .update('user-identity-handle')
  .digest();

/**
 * Derives the stable, opaque handle under which one user appears inside one
 * scope, such as a single meeting. Two rows of the same scope naming the same
 * user share a handle, so a client can collapse them onto one avatar request;
 * the same user in another scope gets an unrelated value, so handles cannot be
 * joined across meetings, and the user ID cannot be recovered from either.
 */
export function deriveUserHandle(scope: string, userId: string): string {
  // The scope is length-prefixed, so no scope and user ID can be rearranged
  // into the input of another pair.
  return createHmac('sha256', userHandleKey)
    .update(`${scope.length}:${scope}${userId}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

export function toUserIdentityResponse(
  user: SelectedUser | null,
  scope: string,
): UserIdentityResponse | null {
  if (!user) {
    return null;
  }

  const avatar =
    user.avatarMimeType && user.avatarSizeBytes !== null && user.avatarUpdatedAt
      ? { updatedAt: user.avatarUpdatedAt }
      : null;

  return { handle: deriveUserHandle(scope, user.id), displayName: user.displayName, avatar };
}
