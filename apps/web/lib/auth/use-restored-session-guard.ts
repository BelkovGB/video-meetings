'use client';

import { useEffect } from 'react';

import { readAccessToken } from './session';

/**
 * Sends a page whose session disappeared while it was in the background back to
 * sign-in.
 *
 * Back and forward navigation can resume a page from the browser's back/forward
 * cache instead of mounting it again, so the mount-time session check never
 * runs. Without this guard an authenticated screen repaints with the identity
 * and data it held before the session was cleared — exactly what a user sees
 * after changing the password and pressing Back.
 *
 * The caller passes only the way it clears leftover session keys, because the
 * screens do not all clear the same ones. Leaving is not the caller's to choose:
 * it has to be a document navigation, see below.
 */
export function useRestoredSessionGuard(clearRestoredSession: () => void): void {
  useEffect(() => {
    const guardRestoredPage = (event: PageTransitionEvent) => {
      if (!event.persisted || readAccessToken()) {
        return;
      }

      clearRestoredSession();
      // A document navigation rather than `router.replace`: the app router
      // listens for the same `pageshow` and restores itself to the URL the
      // resumed page was showing, which undoes any client-side redirect started
      // from this event and leaves the authenticated screen on display. Loading
      // the sign-in document also throws away the resumed tree along with the
      // data it still holds for the previous session.
      window.location.replace('/login');
    };

    window.addEventListener('pageshow', guardRestoredPage);

    return () => {
      window.removeEventListener('pageshow', guardRestoredPage);
    };
  }, [clearRestoredSession]);
}
