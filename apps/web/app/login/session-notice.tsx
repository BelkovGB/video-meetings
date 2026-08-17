'use client';

import { Alert } from '@heroui/react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { loginNoticeParam, passwordChangedNotice } from '../../lib/auth/login-notice';

/**
 * Explains why the session ended when the sign-in screen was reached on purpose.
 *
 * The message is the only explanation the user gets for being signed out, so it
 * has to reach assistive technology too. A live region that enters the DOM
 * already filled is announced unreliably, so the region mounts empty, receives
 * its text in a later commit, and then takes focus: a screen reader hears the
 * notice, and a keyboard user tabs from it straight into the sign-in form.
 */
export function SessionNotice() {
  const notice = useSearchParams().get(loginNoticeParam);
  const isPasswordChanged = notice === passwordChangedNotice;
  const [isAnnounced, setIsAnnounced] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isPasswordChanged) {
      setIsAnnounced(true);
    }
  }, [isPasswordChanged]);

  useEffect(() => {
    if (isAnnounced) {
      noticeRef.current?.focus();
    }
  }, [isAnnounced]);

  if (!isPasswordChanged) {
    return null;
  }

  return (
    <div
      ref={noticeRef}
      role="status"
      tabIndex={-1}
      className="mt-6 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2"
    >
      {isAnnounced ? (
        <Alert status="success" className="rounded-xl">
          Пароль изменён. Войдите заново с новым паролем.
        </Alert>
      ) : null}
    </div>
  );
}
