'use client';

import { Spinner } from '@heroui/react';

import { formatMeetingDateWithYear } from '../../../lib/format/dates';
import { MeetingFileList } from './meeting-file-list';
import { MeetingFileUpload } from './meeting-file-upload';
import { MeetingFilesHeader } from './meeting-files-header';
import { useMeetingFiles } from './use-meeting-files';

type MeetingFilesPageProps = {
  meetingId: string;
};

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

export function MeetingFilesPage({ meetingId }: MeetingFilesPageProps) {
  const {
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
  } = useMeetingFiles(meetingId);

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
        <MeetingFilesHeader />

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
                onStart={clearMessages}
                onError={showActionError}
                onUploaded={addUploadedFile}
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

              <MeetingFileList
                files={files}
                canDelete={meeting.accessRole === 'owner'}
                downloadingId={downloadingId}
                deletingId={deletingId}
                deleteCandidateId={deleteCandidateId}
                onDownload={downloadFile}
                onRequestDelete={requestDelete}
                onCancelDelete={cancelDelete}
                onConfirmDelete={deleteFile}
              />
            </section>
          </>
        )}
      </div>
    </main>
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
