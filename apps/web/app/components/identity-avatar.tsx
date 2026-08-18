'use client';

import { useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import { readAccessToken } from '../../lib/auth/session';

type IdentityAvatarImage = {
  /**
   * API path that streams the image to the bearer token of this session. Every
   * caller passes a path the API already authorizes for the current viewer —
   * `/users/me/avatar` for the account itself, and the meeting-file route for
   * an uploader — so no component here needs, or may take, a user ID.
   */
  path: string;
  /** Changes when the image is replaced, and re-fetches it. */
  updatedAt: string;
};

type IdentityAvatarProps = {
  /** `null` when there is no image to load, which renders the fallback. */
  image: IdentityAvatarImage | null;
  accessibleName: string;
  /** Neutral glyph shown whenever no image is displayed. */
  fallback: string;
  testId: string;
  className?: string;
};

/**
 * A user's avatar as everyone else in the product sees it: the image when it
 * loads, and the same accessible neutral fallback when it is absent, removed,
 * or unavailable.
 */
export function IdentityAvatar({
  image,
  accessibleName,
  fallback,
  testId,
  className = '',
}: IdentityAvatarProps) {
  const [loaded, setLoaded] = useState<{ url: string; key: string } | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const imageKey = image ? `${image.path}|${image.updatedAt}` : null;
  const imageUrl = loaded && loaded.key === imageKey ? loaded.url : null;

  useEffect(() => {
    if (!image || !imageKey) {
      setLoaded(null);
      return;
    }

    const token = readAccessToken();
    if (!token) {
      setLoaded(null);
      return;
    }

    let isActive = true;
    let objectUrl: string | null = null;

    const loadAvatar = async () => {
      try {
        const response = await fetch(`${apiUrl}${image.path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error('Unable to load avatar');
        }

        objectUrl = URL.createObjectURL(await response.blob());
        if (isActive) {
          objectUrlRef.current = objectUrl;
          setLoaded({ url: objectUrl, key: imageKey });
        } else {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
      } catch {
        if (isActive) {
          setLoaded(null);
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
  }, [imageKey]);

  if (imageUrl) {
    return (
      <img
        data-testid={testId}
        src={imageUrl}
        alt={accessibleName}
        className={`shrink-0 rounded-full object-cover ${className}`}
        onError={() => {
          if (objectUrlRef.current === imageUrl) {
            URL.revokeObjectURL(imageUrl);
            objectUrlRef.current = null;
          }
          setLoaded(null);
        }}
      />
    );
  }

  return (
    <span
      data-testid={testId}
      role="img"
      aria-label={accessibleName}
      className={`grid shrink-0 place-items-center rounded-full bg-slate-700 font-semibold text-cyan-50 ${className}`}
    >
      {fallback}
    </span>
  );
}
