'use client';

import { Spinner } from '@heroui/react';
import { useRef } from 'react';

import type { MeetingFile } from '../../../lib/api/contracts';
import { formatUploadDate } from '../../../lib/format/dates';
import { formatFileSize } from '../../../lib/format/file-size';
import { formatUploaderName } from '../../../lib/format/user-identity';
import { DeleteFileConfirmation } from './delete-file-confirmation';
import { DownloadIcon, FileIcon, TrashIcon } from './meeting-file-list-icons';
import { MeetingFileUploaderAvatar } from './meeting-file-uploader-avatar';
import { transcriptionFailureReasons, transcriptionStatusLabels } from './transcription-status';

type MeetingFileRowProps = {
  meetingId: string;
  file: MeetingFile;
  canDelete: boolean;
  isDownloading: boolean;
  isDeleting: boolean;
  isConfirmingDelete: boolean;
  onDownload: (file: MeetingFile) => void;
  onRequestDelete: (file: MeetingFile) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (file: MeetingFile) => void;
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

export function MeetingFileRow({
  meetingId,
  file,
  canDelete,
  isDownloading,
  isDeleting,
  isConfirmingDelete,
  onDownload,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: MeetingFileRowProps) {
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const cancelDelete = () => {
    onCancelDelete();
    requestAnimationFrame(() => deleteButtonRef.current?.focus());
  };

  return (
    <li className="rounded-2xl border border-slate-200 bg-slate-50 p-4 transition duration-200 hover:border-cyan-300 hover:bg-white sm:p-5">
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
            <span aria-hidden="true" className="text-slate-300">
              •
            </span>
            <span className="inline-flex min-w-0 items-center gap-2">
              <MeetingFileUploaderAvatar meetingId={meetingId} file={file} />
              <span className="break-words">
                Загрузил(а): {formatUploaderName(file.uploadedBy)}
              </span>
            </span>
            {file.transcriptionStatus !== null ? (
              <>
                <span aria-hidden="true" className="text-slate-300">
                  •
                </span>
                <span data-testid="transcription-status">
                  {transcriptionStatusLabels[file.transcriptionStatus]}
                </span>
                {file.transcriptionStatus === 'error' && file.transcriptionFailureCode ? (
                  <span data-testid="transcription-failure-reason">
                    {transcriptionFailureReasons[file.transcriptionFailureCode]}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <button
            type="button"
            aria-label={`Скачать ${file.name}`}
            disabled={isDownloading || isDeleting}
            className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition duration-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => onDownload(file)}
          >
            {isDownloading ? <Spinner size="sm" color="current" /> : <DownloadIcon />}
            {isDownloading ? 'Готовим…' : 'Скачать'}
          </button>
          {canDelete ? (
            <button
              ref={deleteButtonRef}
              type="button"
              aria-label={`Удалить ${file.name}`}
              disabled={isDeleting || isDownloading}
              className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 transition duration-200 hover:border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onRequestDelete(file)}
            >
              <TrashIcon />
              Удалить
            </button>
          ) : null}
        </div>
      </div>

      {isConfirmingDelete ? (
        <DeleteFileConfirmation
          file={file}
          isDeleting={isDeleting}
          onCancel={cancelDelete}
          onConfirm={onConfirmDelete}
        />
      ) : null}
    </li>
  );
}
