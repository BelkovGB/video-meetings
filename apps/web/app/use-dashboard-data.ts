'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../lib/api/config';
import type { CurrentUserProfile, Meeting } from '../lib/api/contracts';
import {
  clearSession,
  readAccessToken,
  readDisplayName,
  readUserEmail,
  removeStoredDisplayName,
  writeDisplayName,
} from '../lib/auth/session';
import { useRestoredSessionGuard } from '../lib/auth/use-restored-session-guard';

type DashboardData = {
  identity: string;
  displayName: string | null;
  avatar: CurrentUserProfile['avatar'];
  meetings: Meeting[];
  isLoading: boolean;
  loadError: string | null;
  prependMeeting: (meeting: Meeting) => void;
  retryLoadingMeetings: () => void;
  logout: () => void;
};

function getEmailFromToken(token: string) {
  try {
    const encodedPayload = token.split('.')[1];
    const normalizedPayload = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(
      atob(normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=')),
    ) as { email?: string };

    return payload.email ?? '';
  } catch {
    return '';
  }
}

function clearSessionAndRedirectToLogin(router: ReturnType<typeof useRouter>) {
  clearSession();
  router.replace('/login');
}

/**
 * Loads everything the dashboard needs for the signed-in user and redirects to
 * the login page whenever the stored session turns out to be unusable.
 */
export function useDashboardData(): DashboardData {
  const router = useRouter();
  const [identity, setIdentity] = useState('');
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<CurrentUserProfile['avatar']>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempts, setLoadAttempts] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const returnToLogin = useCallback(() => {
    clearSessionAndRedirectToLogin(router);
  }, [router]);

  useRestoredSessionGuard(returnToLogin);

  useEffect(() => {
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    const email = readUserEmail() ?? getEmailFromToken(token);
    const savedDisplayName = readDisplayName();
    setDisplayName(savedDisplayName);
    setIdentity(savedDisplayName || email);
    let isDashboardActive = true;
    const currentUserRequest = new AbortController();

    const hydrateCurrentUserIdentity = async () => {
      try {
        const response = await fetch(`${apiUrl}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: currentUserRequest.signal,
        });

        if (!isDashboardActive) {
          return;
        }

        if (response.status === 401) {
          clearSessionAndRedirectToLogin(router);
          return;
        }

        if (!response.ok) {
          return;
        }

        const profile = (await response.json()) as CurrentUserProfile;
        if (!isDashboardActive) {
          return;
        }
        const savedDisplayName = profile.displayName?.trim() || null;

        if (savedDisplayName) {
          writeDisplayName(savedDisplayName);
        } else {
          removeStoredDisplayName();
        }

        setDisplayName(savedDisplayName);
        setAvatar(profile.avatar);
        setIdentity(savedDisplayName || email);
      } catch {
        // Keep the locally available identity while the profile service is unavailable.
      }
    };

    const loadMeetings = async () => {
      try {
        const response = await fetch(`${apiUrl}/meetings`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
          clearSessionAndRedirectToLogin(router);
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load meetings');
        }

        setMeetings((await response.json()) as Meeting[]);
      } catch {
        setLoadError('Не удалось загрузить встречи. Проверьте соединение и повторите попытку.');
      } finally {
        setIsLoading(false);
      }
    };

    void hydrateCurrentUserIdentity();
    void loadMeetings();

    return () => {
      isDashboardActive = false;
      currentUserRequest.abort();
    };
  }, [loadAttempts, router]);

  return {
    identity,
    displayName,
    avatar,
    meetings,
    isLoading,
    loadError,
    prependMeeting: (meeting) => {
      setMeetings((currentMeetings) => [meeting, ...currentMeetings]);
    },
    retryLoadingMeetings: () => {
      setLoadError(null);
      setIsLoading(true);
      setLoadAttempts((currentAttempt) => currentAttempt + 1);
    },
    logout: returnToLogin,
  };
}
