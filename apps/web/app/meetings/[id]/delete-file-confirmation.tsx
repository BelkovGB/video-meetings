'use client';

import { Spinner } from '@heroui/react';
import { useEffect, useRef } from 'react';

import type { MeetingFile } from '../../../lib/api/contracts';
import { TrashIcon } from './meeting-file-list-icons';

type DeleteFileConfirmationProps = {
  file: MeetingFile;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: (file: MeetingFile) => void;
};

export function DeleteFileConfirmation({
  file,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteFileConfirmationProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`delete-title-${file.id}`}
      aria-describedby={`delete-description-${file.id}`}
      className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isDeleting) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div>
        <p id={`delete-title-${file.id}`} className="font-semibold text-red-950">
          Удалить файл без возможности восстановления?
        </p>
        <p id={`delete-description-${file.id}`} className="mt-1 text-sm text-red-800">
          «{file.name}» исчезнет у всех участников встречи.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 sm:mt-0 sm:shrink-0">
        <button
          ref={cancelButtonRef}
          type="button"
          className="min-h-11 cursor-pointer touch-manipulation rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
          onClick={onCancel}
        >
          Отмена
        </button>
        <button
          type="button"
          aria-label={`Подтвердить удаление ${file.name}`}
          disabled={isDeleting}
          className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl bg-red-700 px-4 text-sm font-semibold text-white transition hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => onConfirm(file)}
        >
          {isDeleting ? <Spinner size="sm" color="current" /> : <TrashIcon />}
          {isDeleting ? 'Удаляем…' : 'Удалить файл'}
        </button>
      </div>
    </div>
  );
}
