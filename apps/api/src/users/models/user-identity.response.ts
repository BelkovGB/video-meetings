import { Prisma } from '@prisma/client';

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

export type UserIdentityResponse = {
  displayName: string | null;
  avatar: { updatedAt: Date } | null;
};

type SelectedUser = Prisma.UserGetPayload<{ select: typeof userIdentitySelect }>;

export function toUserIdentityResponse(user: SelectedUser | null): UserIdentityResponse | null {
  if (!user) {
    return null;
  }

  const avatar =
    user.avatarMimeType && user.avatarSizeBytes !== null && user.avatarUpdatedAt
      ? { updatedAt: user.avatarUpdatedAt }
      : null;

  return { displayName: user.displayName, avatar };
}
