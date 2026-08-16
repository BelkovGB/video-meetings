'use client';

import { Alert } from '@heroui/react';
import { useSearchParams } from 'next/navigation';

import { loginNoticeParam, passwordChangedNotice } from '../../lib/auth/login-notice';

/** Explains why the session ended when the sign-in screen was reached on purpose. */
export function SessionNotice() {
  const notice = useSearchParams().get(loginNoticeParam);

  if (notice !== passwordChangedNotice) {
    return null;
  }

  return (
    <Alert role="status" status="success" className="mt-6 rounded-xl">
      Пароль изменён. Войдите заново с новым паролем.
    </Alert>
  );
}
