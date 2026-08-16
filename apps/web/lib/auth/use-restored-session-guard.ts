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
 */
export function useRestoredSessionGuard(returnToLogin: () => void): void {
  useEffect(() => {
    const guardRestoredPage = (event: PageTransitionEvent) => {
      if (event.persisted && !readAccessToken()) {
        returnToLogin();
      }
    };

    window.addEventListener('pageshow', guardRestoredPage);

    return () => {
      window.removeEventListener('pageshow', guardRestoredPage);
    };
  }, [returnToLogin]);
}
