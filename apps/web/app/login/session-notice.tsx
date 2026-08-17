'use client';

import { Alert } from '@heroui/react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  loginNoticeParam,
  passwordChangedNotice,
  sessionRejectedNotice,
} from '../../lib/auth/login-notice';

type Notice = { status: 'success' | 'warning'; message: string };

// A `Map` rather than an object literal: the reason comes off the URL, and a
// crafted `constructor` or `toString` would resolve to an inherited function in
// a literal and render as an unreadable notice.
const noticesByReason = new Map<string, Notice>([
  [
    passwordChangedNotice,
    { status: 'success', message: 'Пароль изменён. Войдите заново с новым паролем.' },
  ],
  [
    sessionRejectedNotice,
    {
      status: 'warning',
      message: 'Пароль не изменён: сессия устарела. Войдите заново и повторите попытку.',
    },
  ],
]);

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
  const reason = useSearchParams().get(loginNoticeParam);
  const notice = reason === null ? undefined : noticesByReason.get(reason);
  const [isAnnounced, setIsAnnounced] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (notice) {
      setIsAnnounced(true);
    }
  }, [notice]);

  useEffect(() => {
    if (isAnnounced) {
      noticeRef.current?.focus();
    }
  }, [isAnnounced]);

  if (!notice) {
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
        <Alert status={notice.status} className="rounded-xl">
          {notice.message}
        </Alert>
      ) : null}
    </div>
  );
}
