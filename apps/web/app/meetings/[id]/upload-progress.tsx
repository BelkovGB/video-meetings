'use client';

import { formatFileSize } from '../../../lib/format/file-size';
import { getUploadPhase, type UploadPhase, type UploadState } from './use-meeting-file-upload';

type UploadProgressProps = {
  upload: UploadState;
  onCancel: () => void;
};

function getPhaseMessage(phase: UploadPhase, progress: number): string {
  switch (phase) {
    case 'uploading':
      return `Передаём файл — ${progress}%`;
    case 'processing':
      return 'Файл передан. Проверяем и сохраняем…';
    case 'success':
      return 'Загрузка завершена.';
    case 'error':
      return 'Загрузка не завершена. Исправьте ошибку и попробуйте снова.';
    case 'cancelled':
      return 'Загрузка отменена. Для повтора выберите файл снова.';
  }
}

export function UploadProgress({ upload, onCancel }: UploadProgressProps) {
  const phase = getUploadPhase(upload);

  return (
    <div aria-live="polite" className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-slate-950">{upload.fileName}</p>
          <p className="mt-1 text-xs text-slate-500">{formatFileSize(upload.sizeBytes)}</p>
        </div>
        {upload.status === 'running' ? (
          <button
            type="button"
            className="min-h-11 cursor-pointer touch-manipulation rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
            onClick={onCancel}
          >
            Отменить
          </button>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={`Загрузка ${upload.fileName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={upload.progress}
        aria-valuetext={
          phase === 'processing' ? 'Файл передан. Проверяем и сохраняем.' : `${upload.progress}%`
        }
        className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200"
      >
        <div
          className="h-full w-full origin-left rounded-full bg-cyan-600 transition-transform duration-200 motion-reduce:transition-none"
          style={{ transform: `scaleX(${upload.progress / 100})` }}
        />
      </div>
      <p className="mt-2 text-sm font-medium text-slate-700">
        {getPhaseMessage(phase, upload.progress)}
      </p>
    </div>
  );
}
