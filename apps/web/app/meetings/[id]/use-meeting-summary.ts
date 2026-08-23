'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { apiUrl } from '../../../lib/api/config';
import type { CodedApiError, MeetingSummaryResponse } from '../../../lib/api/contracts';
import { apiErrorMessage, readApiErrorBody } from '../../../lib/api/errors';
import { sessionRejectedLoginPath } from '../../../lib/auth/login-notice';
import { clearSessionIdentity, readAccessToken } from '../../../lib/auth/session';

const noSummaryYet: MeetingSummaryResponse = {
  status: null,
  summary: null,
  failureCode: null,
  tasks: [],
  decisions: [],
};

// `null` counts as pending too: it means no job has ever started, which the
// scheduler can still change on its own without any user action. Polling
// stops only once a run actually reaches a terminal state.
function isSummaryPending(status: MeetingSummaryResponse['status']): boolean {
  return status === null || status === 'queued' || status === 'processing';
}

const startErrorMessages: Record<string, string> = {
  NO_TRANSCRIPT_FILES: 'У встречи нет готового транскрипта.',
  SUMMARY_ALREADY_RUNNING: 'Выжимка уже обрабатывается — дождитесь завершения.',
};

function getStartErrorMessage(body: CodedApiError | null): string {
  if (body?.code && Object.hasOwn(startErrorMessages, body.code)) {
    return startErrorMessages[body.code];
  }

  return apiErrorMessage(body, 'Не удалось запустить выжимку. Попробуйте ещё раз.');
}

export function useMeetingSummary(meetingId: string) {
  const router = useRouter();
  const [summary, setSummary] = useState<MeetingSummaryResponse>(noSummaryYet);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);

  // A meeting the user just lost access to (removed while the tab stayed
  // open) is a different page every time it's opened, so a stale "stopped"
  // flag from a previous meeting must not carry over.
  useEffect(() => {
    setPollingStopped(false);
  }, [meetingId]);

  useEffect(() => {
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    const loadSummary = async () => {
      try {
        const response = await fetch(`${apiUrl}/meetings/${meetingId}/summary`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
          clearSessionIdentity();
          router.replace(sessionRejectedLoginPath);
          return;
        }

        if (response.status === 403 || response.status === 404) {
          setPollingStopped(true);
          return;
        }

        if (!response.ok) {
          return;
        }

        setSummary((await response.json()) as MeetingSummaryResponse);
      } catch {
        // A failed initial read leaves the panel showing the start button;
        // pressing it retries through the same POST call.
      }
    };

    void loadSummary();
  }, [meetingId, router]);

  const POLL_INTERVAL_MS = 4000;
  const MAX_POLL_BACKOFF_MS = 30000;
  const isPending = isSummaryPending(summary.status);

  // Polls while the job is queued or processing, so the already-open page
  // picks up the finished summary without a reload.
  //
  // Depends on the derived `isPending` boolean, not on `summary` itself:
  // every poll response gives `summary` a new object reference, which would
  // tear down and restart this effect (and its setTimeout chain) after every
  // single tick. `isPending` stays the same primitive value across polls that
  // are still pending, so the effect only re-runs when polling should start
  // or stop.
  useEffect(() => {
    if (!isPending || pollingStopped) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let consecutiveFailures = 0;

    const pollOnce = async () => {
      const token = readAccessToken();

      if (!token) {
        return;
      }

      try {
        const response = await fetch(`${apiUrl}/meetings/${meetingId}/summary`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (cancelled) {
          return;
        }

        if (response.status === 401) {
          clearSessionIdentity();
          router.replace(sessionRejectedLoginPath);
          return;
        }

        if (response.status === 403 || response.status === 404) {
          setPollingStopped(true);
          return;
        }

        if (!response.ok) {
          consecutiveFailures += 1;
          scheduleNext(consecutiveFailures);
          return;
        }

        consecutiveFailures = 0;
        const next = (await response.json()) as MeetingSummaryResponse;

        if (cancelled) {
          return;
        }

        setSummary(next);

        if (isSummaryPending(next.status)) {
          scheduleNext(0);
        }
      } catch {
        // A transient network failure during a background poll should not
        // surface as an error; just try again, with backoff.
        if (!cancelled) {
          consecutiveFailures += 1;
          scheduleNext(consecutiveFailures);
        }
      }
    };

    const scheduleNext = (failureCount: number) => {
      const delay = Math.min(POLL_INTERVAL_MS * 2 ** failureCount, MAX_POLL_BACKOFF_MS);
      timeoutId = setTimeout(() => {
        void pollOnce();
      }, delay);
    };

    scheduleNext(0);

    return () => {
      cancelled = true;

      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, [meetingId, router, isPending, pollingStopped]);

  const startSummary = async () => {
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    setStartError(null);
    setIsStarting(true);

    try {
      const response = await fetch(`${apiUrl}/meetings/${meetingId}/summary`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401) {
        clearSessionIdentity();
        router.replace(sessionRejectedLoginPath);
        return;
      }

      if (!response.ok) {
        setStartError(getStartErrorMessage(await readApiErrorBody(response)));
        return;
      }

      // Replaces the local state with the freshly queued job so the panel
      // flips to "queued" immediately; the poll effect above picks up from
      // there once `isPending` turns true.
      setSummary((await response.json()) as MeetingSummaryResponse);
    } catch {
      setStartError('Не удалось запустить выжимку. Проверьте соединение и попробуйте ещё раз.');
    } finally {
      setIsStarting(false);
    }
  };

  return { summary, isStarting, startError, startSummary };
}
