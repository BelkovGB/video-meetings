'use client';

import { Spinner } from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../../lib/api/config';
import type { ApiError, Meeting, MeetingFile } from '../../../lib/api/contracts';
import { clearAccessToken, clearSessionIdentity, readAccessToken } from '../../../lib/auth/session';
import { formatMeetingDateWithYear, formatUploadDate } from '../../../lib/format/dates';
import { formatFileSize } from '../../../lib/format/file-size';
import { MeetingFileUpload } from './meeting-file-upload';

type MeetingFilesPageProps = {
  meetingId: string;
};

const categoryLabels: Record<Exclude<MeetingFile['category'], 'document'>, string> = {
  audio: 'Аудиозапись',
  video: 'Видеозапись',
  transcript: 'Транскрипт',
};

function getCategoryLabel(file: MeetingFile): string {
  if (file.category === 'document') {
    return file.mimeType === 'application/pdf' ? 'PDF-документ' : 'Документ';
  }

  return categoryLabels[file.category];
}

function formatFileCount(count: number): string {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return `${count} файлов`;
  }

  if (lastDigit === 1) {
    return `${count} файл`;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return `${count} файла`;
  }

  return `${count} файлов`;
}

function getApiMessage(error: ApiError, fallback: string): string {
  return typeof error.message === 'string' ? error.message : fallback;
}

export function MeetingFilesPage({ meetingId }: MeetingFilesPageProps) {
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
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const shouldFocusStatusRef = useRef(false);
  const statusMessageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (deleteCandidateId) {
      cancelDeleteButtonRef.current?.focus();
    }
  }, [deleteCandidateId]);

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

  const cancelDelete = (fileId: string) => {
    setDeleteCandidateId(null);
    requestAnimationFrame(() => deleteButtonRefs.current.get(fileId)?.focus());
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
        setActionError(getApiMessage(data, `Не удалось скачать «${file.name}».`));
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
        const data = (await response.json()) as ApiError;
        setActionError(getApiMessage(data, `Не удалось удалить «${file.name}».`));
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

  if (isLoading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-slate-950 text-white">
        <div className="text-center">
          <Spinner color="current" size="lg" />
          <p className="mt-4 text-sm text-slate-300">Загружаем файлы встречи…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-950 px-4 py-5 text-white sm:px-8 sm:py-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 pb-5">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-slate-200 transition duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            <ArrowLeftIcon />
            Все встречи
          </Link>
          <span className="hidden text-sm font-semibold tracking-wide text-cyan-100 sm:block">
            VIDEO MEETINGS
          </span>
        </header>

        {loadError || !meeting ? (
          <section className="mx-auto mt-16 max-w-xl rounded-3xl border border-red-300/20 bg-red-300/10 p-7 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-red-300/10 text-red-200">
              <WarningIcon />
            </span>
            <h1 className="mt-5 text-2xl font-semibold">Не удалось открыть встречу</h1>
            <p role="alert" className="mt-3 text-sm leading-6 text-red-100/80">
              {loadError}
            </p>
            <button
              type="button"
              className="mt-6 min-h-11 cursor-pointer touch-manipulation rounded-xl bg-white px-5 text-sm font-semibold text-slate-950 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
              onClick={retryLoading}
            >
              Повторить
            </button>
          </section>
        ) : (
          <>
            <section className="grid gap-6 py-9 lg:grid-cols-[1fr_auto] lg:items-end lg:py-12">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-cyan-200/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-100">
                    {meeting.accessRole === 'owner' ? 'Владелец' : 'Участник'}
                  </span>
                  <span className="text-sm text-slate-400">
                    {formatMeetingDateWithYear(meeting.date)}
                  </span>
                </div>
                <h1 className="mt-4 max-w-4xl break-words text-3xl font-semibold tracking-tight sm:text-5xl">
                  {meeting.title}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
                  Записи, транскрипты и рабочие документы этой встречи собраны в одном месте.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.06] px-5 py-4 lg:min-w-44">
                <p className="text-sm text-slate-400">Файлов доступно</p>
                <p className="mt-1 text-3xl font-semibold text-white">{files.length}</p>
              </div>
            </section>

            <section
              aria-labelledby="meeting-files-title"
              className="rounded-3xl border border-slate-200 bg-white p-5 text-slate-950 shadow-2xl shadow-black/20 sm:p-8"
            >
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
                <div>
                  <p className="text-sm font-semibold text-cyan-700">Материалы встречи</p>
                  <h2
                    id="meeting-files-title"
                    className="mt-1 text-2xl font-semibold tracking-tight"
                  >
                    Файлы встречи
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Загрузка и скачивание доступны всем участникам, удаление — только владельцу.
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-600">
                  {formatFileCount(files.length)}
                </span>
              </div>

              <MeetingFileUpload
                meetingId={meetingId}
                onStart={() => {
                  setActionError(null);
                  setStatusMessage(null);
                }}
                onError={(message) => {
                  setStatusMessage(null);
                  setActionError(message);
                }}
                onUploaded={(file) => {
                  setActionError(null);
                  setFiles((currentFiles) => [file, ...currentFiles]);
                  setStatusMessage(`Файл «${file.name}» загружен.`);
                }}
              />

              <div aria-live="polite" className="mt-4 space-y-3">
                {statusMessage ? (
                  <div
                    ref={statusMessageRef}
                    role="status"
                    tabIndex={-1}
                    className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2"
                  >
                    {statusMessage}
                  </div>
                ) : null}
                {actionError ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800"
                  >
                    {actionError}
                  </div>
                ) : null}
              </div>

              {files.length === 0 ? (
                <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-12 text-center">
                  <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-cyan-100 text-cyan-800">
                    <FileIcon />
                  </span>
                  <h3 className="mt-4 text-lg font-semibold">У встречи пока нет файлов</h3>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
                    Когда появятся записи или документы, они будут доступны здесь участникам
                    встречи.
                  </p>
                </div>
              ) : (
                <ul className="mt-6 space-y-3">
                  {files.map((file) => {
                    const isConfirmingDelete = deleteCandidateId === file.id;
                    const isDownloading = downloadingId === file.id;
                    const isDeleting = deletingId === file.id;

                    return (
                      <li
                        key={file.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4 transition duration-200 hover:border-cyan-300 hover:bg-white sm:p-5"
                      >
                        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-cyan-100 text-cyan-800">
                            <FileIcon />
                          </span>
                          <div className="min-w-0">
                            <p className="break-words font-semibold text-slate-950">{file.name}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                              <span>{getCategoryLabel(file)}</span>
                              <span aria-hidden="true" className="text-slate-300">
                                •
                              </span>
                              <span>{formatFileSize(file.sizeBytes)}</span>
                              <span aria-hidden="true" className="text-slate-300">
                                •
                              </span>
                              <span>{formatUploadDate(file.uploadedAt)}</span>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2 sm:justify-end">
                            <button
                              type="button"
                              aria-label={`Скачать ${file.name}`}
                              disabled={isDownloading || isDeleting}
                              className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition duration-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                              onClick={() => void downloadFile(file)}
                            >
                              {isDownloading ? (
                                <Spinner size="sm" color="current" />
                              ) : (
                                <DownloadIcon />
                              )}
                              {isDownloading ? 'Готовим…' : 'Скачать'}
                            </button>
                            {meeting.accessRole === 'owner' ? (
                              <button
                                ref={(button) => {
                                  if (button) {
                                    deleteButtonRefs.current.set(file.id, button);
                                  } else {
                                    deleteButtonRefs.current.delete(file.id);
                                  }
                                }}
                                type="button"
                                aria-label={`Удалить ${file.name}`}
                                disabled={isDeleting || isDownloading}
                                className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 transition duration-200 hover:border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                                onClick={() => {
                                  setActionError(null);
                                  setStatusMessage(null);
                                  setDeleteCandidateId(file.id);
                                }}
                              >
                                <TrashIcon />
                                Удалить
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {isConfirmingDelete ? (
                          <div
                            role="alertdialog"
                            aria-modal="false"
                            aria-labelledby={`delete-title-${file.id}`}
                            aria-describedby={`delete-description-${file.id}`}
                            className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4"
                            onKeyDown={(event) => {
                              if (event.key === 'Escape' && !isDeleting) {
                                event.preventDefault();
                                cancelDelete(file.id);
                              }
                            }}
                          >
                            <div>
                              <p
                                id={`delete-title-${file.id}`}
                                className="font-semibold text-red-950"
                              >
                                Удалить файл без возможности восстановления?
                              </p>
                              <p
                                id={`delete-description-${file.id}`}
                                className="mt-1 text-sm text-red-800"
                              >
                                «{file.name}» исчезнет у всех участников встречи.
                              </p>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-2 sm:mt-0 sm:shrink-0">
                              <button
                                ref={cancelDeleteButtonRef}
                                type="button"
                                className="min-h-11 cursor-pointer touch-manipulation rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
                                onClick={() => cancelDelete(file.id)}
                              >
                                Отмена
                              </button>
                              <button
                                type="button"
                                aria-label={`Подтвердить удаление ${file.name}`}
                                disabled={isDeleting}
                                className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl bg-red-700 px-4 text-sm font-semibold text-white transition hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                                onClick={() => void deleteFile(file)}
                              >
                                {isDeleting ? <Spinner size="sm" color="current" /> : <TrashIcon />}
                                {isDeleting ? 'Удаляем…' : 'Удалить файл'}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function ArrowLeftIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="m15 18-6-6 6-6M9 12h11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
      <path
        d="M7 3.8h6.2L18 8.6v11.6H7V3.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path d="M13 4v5h5" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M5 7h14m-9-3h4l1 3H9l1-3Zm-2 3 1 13h6l1-13M10 11v5m4-5v5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 4 3.5 19h17L12 4Zm0 5.5v4m0 2.8v.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
