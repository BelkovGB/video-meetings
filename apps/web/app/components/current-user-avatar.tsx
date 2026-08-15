'use client';

import { useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import type { Avatar } from '../../lib/api/contracts';

type CurrentUserAvatarProps = {
  avatar: Avatar | null;
  displayName: string | null;
  className?: string;
};

export function CurrentUserAvatar({ avatar, displayName, className = '' }: CurrentUserAvatarProps) {
  const [image, setImage] = useState<{ url: string; updatedAt: string } | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const trimmedDisplayName = displayName?.trim() || null;
  const accessibleName = trimmedDisplayName
    ? `Аватар пользователя ${trimmedDisplayName}`
    : 'Аватар пользователя, имя не указано';
  const fallback = trimmedDisplayName
    ? Array.from(trimmedDisplayName)[0].toLocaleUpperCase('ru-RU')
    : '?';
  const imageUrl = image && image.updatedAt === avatar?.updatedAt ? image.url : null;

  useEffect(() => {
    if (!avatar) {
      setImage(null);
      return;
    }

    const token = sessionStorage.getItem('accessToken');
    if (!token) {
      setImage(null);
      return;
    }

    let isActive = true;
    let objectUrl: string | null = null;

    const loadAvatar = async () => {
      try {
        const response = await fetch(`${apiUrl}/users/me/avatar`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error('Unable to load avatar');
        }

        objectUrl = URL.createObjectURL(await response.blob());
        if (isActive) {
          objectUrlRef.current = objectUrl;
          setImage({ url: objectUrl, updatedAt: avatar.updatedAt });
        } else {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
      } catch {
        if (isActive) {
          setImage(null);
        }
      }
    };

    void loadAvatar();

    return () => {
      isActive = false;
      if (objectUrl && objectUrlRef.current === objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrlRef.current = null;
      }
    };
  }, [avatar?.updatedAt]);

  if (imageUrl) {
    return (
      <img
        data-testid="current-user-avatar"
        src={imageUrl}
        alt={accessibleName}
        className={`shrink-0 rounded-full object-cover ${className}`}
        onError={() => {
          if (objectUrlRef.current === imageUrl) {
            URL.revokeObjectURL(imageUrl);
            objectUrlRef.current = null;
          }
          setImage(null);
        }}
      />
    );
  }

  return (
    <span
      data-testid="current-user-avatar"
      role="img"
      aria-label={accessibleName}
      className={`grid shrink-0 place-items-center rounded-full bg-slate-700 font-semibold text-cyan-50 ${className}`}
    >
      {fallback}
    </span>
  );
}
