'use client';

import { useRouter } from 'next/navigation';
import { Dispatch, SetStateAction, useCallback, useEffect, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import type { CurrentUserProfile } from '../../lib/api/contracts';
import { passwordChangedLoginPath, sessionRejectedLoginPath } from '../../lib/auth/login-notice';
import { clearSession, readAccessToken } from '../../lib/auth/session';
import { useRestoredSessionGuard } from '../../lib/auth/use-restored-session-guard';

type CurrentProfile = {
  profile: CurrentUserProfile | null;
  setProfile: Dispatch<SetStateAction<CurrentUserProfile | null>>;
  isLoading: boolean;
  loadError: string | null;
  /** Clears the session and returns to the login screen. */
  handleUnauthorized: () => void;
  /** Clears the session and returns to the login screen explaining the new sign-in. */
  handlePasswordChanged: () => void;
  /** Clears the session and returns to the login screen explaining the ended session. */
  handleSessionRejected: () => void;
  retryLoad: () => void;
};

/** Loads the signed-in profile, redirecting to the login screen without a valid token. */
export function useCurrentProfile(): CurrentProfile {
  const router = useRouter();
  const [profile, setProfile] = useState<CurrentUserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const handleUnauthorized = useCallback(() => {
    clearSession();
    router.replace('/login');
  }, [router]);

  const handlePasswordChanged = useCallback(() => {
    clearSession();
    router.replace(passwordChangedLoginPath);
  }, [router]);

  const handleSessionRejected = useCallback(() => {
    clearSession();
    router.replace(sessionRejectedLoginPath);
  }, [router]);

  useRestoredSessionGuard(clearSession);

  useEffect(() => {
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    let isActive = true;

    const loadProfile = async () => {
      try {
        const response = await fetch(`${apiUrl}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
          handleUnauthorized();
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load profile');
        }

        const currentProfile = (await response.json()) as CurrentUserProfile;
        if (isActive) {
          setProfile(currentProfile);
        }
      } catch {
        if (isActive) {
          setLoadError('Не удалось загрузить профиль. Проверьте соединение и повторите попытку.');
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    void loadProfile();

    return () => {
      isActive = false;
    };
  }, [handleUnauthorized, loadAttempt, router]);

  const retryLoad = () => {
    setLoadError(null);
    setIsLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  return {
    profile,
    setProfile,
    isLoading,
    loadError,
    handleUnauthorized,
    handlePasswordChanged,
    handleSessionRejected,
    retryLoad,
  };
}
