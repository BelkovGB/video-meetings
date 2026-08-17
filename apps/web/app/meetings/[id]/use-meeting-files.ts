'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../../lib/api/config';
import type { ApiError, Meeting, MeetingFile } from '../../../lib/api/contracts';
import { apiErrorMessage, readApiErrorMessage } from '../../../lib/api/errors';
import { clearAccessToken, clearSessionIdentity, readAccessToken } from '../../../lib/auth/session';
import { useRestoredSessionGuard } from '../../../lib/auth/use-restored-session-guard';

export function useMeetingFiles(meetingId: string) {
  const router = useRouter();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [files, setFiles] = useState<MeetingFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const shouldFocusStatusRef = useRef(false);
  const statusMessageRef = useRef<HTMLDivElement>(null);

  useRestoredSessionGuard(clearSessionIdentity);

  useEffect(() => {
    if (statusMessage && shouldFocusStatusRef.current) {
      statusMessageRef.current?.focus();
      shouldFocusStatusRef.current = false;
    }
  }, [statusMessage]);

  useEffect(() => {
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    const loadMeetingFiles = async () => {
      setLoadError(null);

      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [meetingResponse, filesResponse] = await Promise.all([
          fetch(`${apiUrl}/meetings/${meetingId}`, { headers }),
          fetch(`${apiUrl}/meetings/${meetingId}/files`, { headers }),
        ]);

        if (meetingResponse.status === 401 || filesResponse.status === 401) {
          clearSessionIdentity();
          router.replace('/login');
          return;
        }

        if (meetingResponse.status === 404 || filesResponse.status === 404) {
          setLoadError('Встреча не найдена или у вас больше нет к ней доступа.');
          return;
        }

        if (!meetingResponse.ok || !filesResponse.ok) {
          throw new Error('Unable to load meeting files');
        }

        setMeeting((await meetingResponse.json()) as Meeting);
        setFiles((await filesResponse.json()) as MeetingFile[]);
      } catch {
        setLoadError(
          'Не удалось загрузить файлы встречи. Проверьте соединение и повторите попытку.',
        );
      } finally {
        setIsLoading(false);
      }
    };

    void loadMeetingFiles();
  }, [loadAttempt, meetingId, router]);

  const retryLoading = () => {
    setIsLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  const clearMessages = () => {
    setActionError(null);
    setStatusMessage(null);
  };

  const showActionError = (message: string) => {
    setStatusMessage(null);
    setActionError(message);
  };

  const addUploadedFile = (file: MeetingFile) => {
    setActionError(null);
    setFiles((currentFiles) => [file, ...currentFiles]);
    setStatusMessage(`Файл «${file.name}» загружен.`);
  };

  const requestDelete = (file: MeetingFile) => {
    setActionError(null);
    setStatusMessage(null);
    setDeleteCandidateId(file.id);
  };

  const cancelDelete = () => {
    setDeleteCandidateId(null);
  };

  const downloadFile = async (file: MeetingFile) => {
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    setActionError(null);
    setStatusMessage(null);
    setDownloadingId(file.id);

    try {
      const response = await fetch(
        `${apiUrl}/meetings/${meetingId}/files/${file.id}/download-ticket`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const data = (await response.json()) as { ticket?: string } & ApiError;

      if (response.status === 401) {
        clearAccessToken();
        router.replace('/login');
        return;
      }

      if (!response.ok || !data.ticket) {
        setActionError(apiErrorMessage(data, `Не удалось скачать «${file.name}».`));
        return;
      }

      const anchor = document.createElement('a');
      anchor.href = `${apiUrl}/file-downloads/${encodeURIComponent(data.ticket)}`;
      anchor.download = file.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setStatusMessage(`Скачивание файла «${file.name}» началось.`);
    } catch {
      setActionError(`Не удалось скачать «${file.name}». Проверьте соединение.`);
    } finally {
      setDownloadingId(null);
    }
  };

  const deleteFile = async (file: MeetingFile) => {
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    setActionError(null);
    setStatusMessage(null);
    setDeletingId(file.id);

    try {
      const response = await fetch(`${apiUrl}/meetings/${meetingId}/files/${file.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401) {
        clearAccessToken();
        router.replace('/login');
        return;
      }

      if (!response.ok) {
        setActionError(await readApiErrorMessage(response, `Не удалось удалить «${file.name}».`));
        return;
      }

      setFiles((currentFiles) => currentFiles.filter((currentFile) => currentFile.id !== file.id));
      setDeleteCandidateId(null);
      shouldFocusStatusRef.current = true;
      setStatusMessage(`Файл «${file.name}» удалён.`);
    } catch {
      setActionError(`Не удалось удалить «${file.name}». Проверьте соединение.`);
    } finally {
      setDeletingId(null);
    }
  };

  return {
    meeting,
    files,
    isLoading,
    loadError,
    actionError,
    statusMessage,
    statusMessageRef,
    downloadingId,
    deletingId,
    deleteCandidateId,
    retryLoading,
    clearMessages,
    showActionError,
    addUploadedFile,
    requestDelete,
    cancelDelete,
    downloadFile,
    deleteFile,
  };
}
