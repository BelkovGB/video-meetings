'use client';

import { useEffect, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import { readAccessToken } from '../../lib/auth/session';
import { acquireAvatarImage, discardAvatarImage } from './avatar-image-cache';

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
  /**
   * Names the image itself, so two components showing one person's avatar
   * through different paths download and hold it once. Omitted where the path
   * already identifies the image, as `/users/me/avatar` does.
   */
  sharedKey?: string;
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
  const imageKey = image ? `${image.sharedKey ?? image.path}|${image.updatedAt}` : null;
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
    const path = image.path;
    const lease = acquireAvatarImage(imageKey, async (signal) => {
      const response = await fetch(`${apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) {
        throw new Error('Unable to load avatar');
      }

      return response.blob();
    });

    void lease.url.then(
      (url) => {
        if (isActive) {
          setLoaded({ url, key: imageKey });
        }
      },
      () => {
        if (isActive) {
          setLoaded(null);
        }
      },
    );

    return () => {
      isActive = false;
      // The image outlives this component only while another one still holds it.
      lease.release();
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
          // The image belongs to every component sharing this key, so it is the
          // cache that frees it and lets the next one try again.
          if (imageKey) {
            discardAvatarImage(imageKey);
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
