'use client';

import type { Avatar } from '../../lib/api/contracts';
import { AvatarUploadForm } from './avatar-upload-form';

type AvatarSectionProps = {
  avatar: Avatar | null;
  /** Receives the saved avatar, or `null` once it is removed. */
  onAvatarChanged: (avatar: Avatar | null) => void;
  onUnauthorized: () => void;
};

export function AvatarSection({ avatar, onAvatarChanged, onUnauthorized }: AvatarSectionProps) {
  return (
    <AvatarUploadForm
      avatar={avatar}
      onAvatarSaved={onAvatarChanged}
      onAvatarRemoved={() => onAvatarChanged(null)}
      onUnauthorized={onUnauthorized}
    />
  );
}
