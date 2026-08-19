'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { apiUrl } from '../../lib/api/config';
import { readAccessToken } from '../../lib/auth/session';
import {
  acquireAvatarImage,
  discardAvatarImage,
  readAvatarImageAttempt,
  subscribeToAvatarImageAttempt,
} from './avatar-image-cache';

type IdentityAvatarImage = {
  /**
   * API path that streams the image to the bearer token of this session. Every
   * caller passes a path the API already authorizes for the current viewer —
   * `/users/me/avatar` for the account itself, and the meeting-scoped uploader
   * route for someone else — so no component here needs, or may take, a user
   * ID. The path names the person rather than the row showing them, so every
   * component displaying one person shares it, and the image is read once.
   */
  path: string;
  /** Changes when the image is replaced, and re-fetches it. */
  updatedAt: string;
};

type IdentityAvatarBaseProps = {
  /** `null` when there is no image to load, which renders the fallback. */
  image: IdentityAvatarImage | null;
  /** Neutral glyph shown whenever no image is displayed. */
  fallback: string;
  testId: string;
  className?: string;
};

type IdentityAvatarProps = IdentityAvatarBaseProps &
  (
    | {
        /** Names the avatar wherever nothing beside it names the person. */
        accessibleName: string;
        decorative?: false;
      }
    | {
        /**
         * Hides the avatar from assistive technology where adjacent text
         * already names the person. Without it a list of files reads the
         * uploader name twice in every row, once for the avatar and once for
         * the text next to it.
         */
        decorative: true;
        accessibleName?: never;
      }
  );

/**
 * A user's avatar as everyone else in the product sees it: the image when it
 * loads, and the same accessible neutral fallback when it is absent, removed,
 * or unavailable.
 */
export function IdentityAvatar({
  image,
  accessibleName,
  decorative = false,
  fallback,
  testId,
  className = '',
}: IdentityAvatarProps) {
  const [loaded, setLoaded] = useState<{ url: string; key: string; attempt: number } | null>(null);
  const imageKey = image ? `${image.path}|${image.updatedAt}` : null;
  // Which image of this key the cache is on. Any component reporting one the
  // browser could not decode moves it, and every other component showing the
  // same key re-runs the effect below: the picture belongs to all of them, so
  // they follow it to its replacement, or to the fallback, together.
  const attempt = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        imageKey ? subscribeToAvatarImageAttempt(imageKey, onChange) : () => undefined,
      [imageKey],
    ),
    () => (imageKey ? readAvatarImageAttempt(imageKey) : 0),
    () => 0,
  );
  const imageUrl =
    loaded && loaded.key === imageKey && loaded.attempt === attempt ? loaded.url : null;

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
        throw new Error(`Unable to load avatar (${response.status})`);
      }

      return response.blob();
    });

    void lease.url.then(
      (url) => {
        if (isActive) {
          setLoaded({ url, key: imageKey, attempt });
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
  }, [imageKey, attempt]);

  if (imageUrl) {
    return (
      <img
        data-testid={testId}
        src={imageUrl}
        alt={decorative ? '' : accessibleName}
        aria-hidden={decorative || undefined}
        className={`shrink-0 rounded-full object-cover ${className}`}
        onError={() => {
          // The image belongs to every component sharing this key, so it is the
          // cache that frees it, reads one replacement for all of them, and
          // decides when the key has no attempt left.
          if (imageKey) {
            discardAvatarImage(imageKey, imageUrl);
          }
          setLoaded(null);
        }}
      />
    );
  }

  return (
    <span
      data-testid={testId}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : accessibleName}
      aria-hidden={decorative || undefined}
      className={`grid shrink-0 place-items-center rounded-full bg-slate-700 font-semibold text-cyan-50 ${className}`}
    >
      {fallback}
    </span>
  );
}
