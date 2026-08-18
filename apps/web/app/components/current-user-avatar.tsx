'use client';

import type { Avatar } from '../../lib/api/contracts';
import { formatIdentityInitial } from '../../lib/format/user-identity';
import { IdentityAvatar } from './identity-avatar';

type CurrentUserAvatarProps = {
  avatar: Avatar | null;
  displayName: string | null;
  className?: string;
};

export function CurrentUserAvatar({ avatar, displayName, className = '' }: CurrentUserAvatarProps) {
  const trimmedDisplayName = displayName?.trim() || null;

  return (
    <IdentityAvatar
      image={avatar ? { path: '/users/me/avatar', updatedAt: avatar.updatedAt } : null}
      accessibleName={
        trimmedDisplayName
          ? `Аватар пользователя ${trimmedDisplayName}`
          : 'Аватар пользователя, имя не указано'
      }
      fallback={formatIdentityInitial(displayName)}
      testId="current-user-avatar"
      className={className}
    />
  );
}
