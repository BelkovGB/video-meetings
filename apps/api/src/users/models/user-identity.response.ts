import { Prisma } from '@prisma/client';

import { deriveAvatarKey } from './avatar-key';

/**
 * The only user fields shared activity may show to another user. Email and every
 * other private profile value stay out, so adding a field here changes what all
 * shared responses expose.
 */
export const userIdentitySelect = {
  displayName: true,
  avatarMimeType: true,
  avatarSizeBytes: true,
  avatarUpdatedAt: true,
} satisfies Prisma.UserSelect;

/**
 * What a query has to read to build an identity: the fields above plus the user
 * ID, which only derives the opaque avatar key and never leaves the API. It is
 * deliberately not part of the allowlist, so a builder that spreads an exposed
 * identity cannot pick the ID up by accident.
 */
export const userIdentityReadSelect = {
  ...userIdentitySelect,
  id: true,
} satisfies Prisma.UserSelect;

export type UserIdentityResponse = {
  displayName: string | null;
  avatar: { key: string; updatedAt: Date } | null;
};

type SelectedUser = Prisma.UserGetPayload<{ select: typeof userIdentityReadSelect }>;

/**
 * @param avatarKeyScope the context the identity is shown in, which bounds how
 *   far the returned avatar key can be compared — a meeting ID for a meeting's
 *   activity, so the same user in another meeting is a different key.
 */
export function toUserIdentityResponse(
  user: SelectedUser | null,
  avatarKeyScope: string,
): UserIdentityResponse | null {
  if (!user) {
    return null;
  }

  const avatar =
    user.avatarMimeType && user.avatarSizeBytes !== null && user.avatarUpdatedAt
      ? { key: deriveAvatarKey(avatarKeyScope, user.id), updatedAt: user.avatarUpdatedAt }
      : null;

  return { displayName: user.displayName, avatar };
}
