'use client';

import { useEffect, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import { readApiErrorBody } from '../../lib/api/errors';
import { readAccessToken } from '../../lib/auth/session';
import {
  AvatarSourceGoneError,
  acquireAvatarImage,
  discardAvatarImage,
} from './avatar-image-cache';

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
 * Tells the one failure the cache may answer by reading another holder's route
 * from the ones it must not. `FILE_NOT_FOUND` is the API saying this route is
 * gone — the meeting file behind this row no longer exists — while the
 * uploader's avatar is still served through their other files. Every other
 * failure, including a bare 404 for an avatar that was removed, answers the
 * same on all of that uploader's routes, so it stops the read at one request
 * instead of one per row.
 */
async function readAvatarFailure(response: Response): Promise<Error> {
  if (response.status === 404) {
    const body = await readApiErrorBody(response);
    if (body?.code === 'FILE_NOT_FOUND') {
      return new AvatarSourceGoneError();
    }
  }

  return new Error(`Unable to load avatar (${response.status})`);
}

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
    const lease = acquireAvatarImage(imageKey, {
      // The route this component was given: another component sharing the key
      // reads the same picture through its own, and the cache falls through to
      // it if this one is gone.
      id: path,
      load: async (signal) => {
        const response = await fetch(`${apiUrl}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok) {
          throw await readAvatarFailure(response);
        }

        return response.blob();
      },
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
        alt={decorative ? '' : accessibleName}
        aria-hidden={decorative || undefined}
        className={`shrink-0 rounded-full object-cover ${className}`}
        onError={() => {
          // The image belongs to every component sharing this key, so it is the
          // cache that frees it and lets the next one try again.
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
