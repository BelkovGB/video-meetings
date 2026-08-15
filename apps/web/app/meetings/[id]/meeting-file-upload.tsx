'use client';

import { useRouter } from 'next/navigation';
import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../../lib/api/config';
import type { MeetingFile, UploadApiError } from '../../../lib/api/contracts';
import { clearSessionIdentity, readAccessToken } from '../../../lib/auth/session';
import { formatFileSize } from '../../../lib/format/file-size';

type MeetingFileUploadProps = {
  meetingId: string;
  onUploaded: (file: MeetingFile) => void;
  onError: (message: string) => void;
  onStart: () => void;
};

type UploadPhase = 'uploading' | 'processing' | 'success' | 'error' | 'cancelled';

type UploadState = {
  fileName: string;
  sizeBytes: number;
  progress: number;
  phase: UploadPhase;
};

const maxUploadBytes = 1_073_741_824;
const minimumProcessingFeedbackMs = 600;
const acceptedExtensions = [
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
  '.mov',
  '.txt',
  '.vtt',
  '.srt',
  '.pdf',
  '.docx',
] as const;
const acceptValue = acceptedExtensions.join(',');
const allowedMimeTypes: Record<(typeof acceptedExtensions)[number], readonly string[]> = {
  '.mp3': ['audio/mpeg'],
  '.m4a': ['audio/mp4', 'audio/x-m4a'],
  '.wav': ['audio/wav', 'audio/x-wav'],
  '.ogg': ['audio/ogg', 'application/ogg'],
  '.mp4': ['video/mp4'],
  '.webm': ['video/webm'],
  '.mov': ['video/quicktime'],
  '.txt': ['text/plain'],
  '.vtt': ['text/vtt'],
  '.srt': ['application/x-subrip', 'text/plain'],
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

const uploadErrorMessages: Record<string, string> = {
  UPLOAD_TOO_LARGE: 'Файл больше 1 ГБ. Выберите файл размером до 1 ГБ.',
  UNSUPPORTED_FILE_TYPE:
    'Этот формат не поддерживается. Выберите аудио, видео, транскрипт, PDF или DOCX.',
  EMPTY_UPLOAD: 'Файл пуст. Выберите другой файл.',
  INVALID_MULTIPART_UPLOAD: 'Не удалось прочитать файл. Выберите его ещё раз.',
  MISSING_UPLOAD: 'Файл не выбран. Выберите файл для загрузки.',
  STORAGE_UNAVAILABLE: 'Хранилище временно недоступно. Попробуйте ещё раз.',
  UPLOAD_BUSY: 'Другая загрузка ещё выполняется. Дождитесь её завершения.',
};

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function getClientValidationError(file: File): string | null {
  if (file.size === 0) {
    return uploadErrorMessages.EMPTY_UPLOAD;
  }

  if (file.size > maxUploadBytes) {
    return uploadErrorMessages.UPLOAD_TOO_LARGE;
  }

  const extension = getExtension(file.name) as (typeof acceptedExtensions)[number];
  const mimeTypes = allowedMimeTypes[extension];
  if (!mimeTypes || (file.type !== '' && !mimeTypes.includes(file.type))) {
    return uploadErrorMessages.UNSUPPORTED_FILE_TYPE;
  }

  return null;
}

function getServerErrorMessage(status: number, error: UploadApiError | null): string {
  if (error?.code && uploadErrorMessages[error.code]) {
    return uploadErrorMessages[error.code];
  }

  if (status === 413) {
    return uploadErrorMessages.UPLOAD_TOO_LARGE;
  }

  if (status === 415) {
    return uploadErrorMessages.UNSUPPORTED_FILE_TYPE;
  }

  if (status === 404) {
    return 'Встреча не найдена или у вас больше нет к ней доступа.';
  }

  if (status === 503) {
    return uploadErrorMessages.STORAGE_UNAVAILABLE;
  }

  return 'Не удалось загрузить файл. Попробуйте ещё раз.';
}

function getPhaseMessage(upload: UploadState): string {
  switch (upload.phase) {
    case 'uploading':
      return `Передаём файл — ${upload.progress}%`;
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

export function MeetingFileUpload({
  meetingId,
  onUploaded,
  onError,
  onStart,
}: MeetingFileUploadProps) {
  const router = useRouter();
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const isBusy = upload?.phase === 'uploading' || upload?.phase === 'processing';

  useEffect(
    () => () => {
      if (requestRef.current) {
        requestRef.current.onabort = null;
        requestRef.current.abort();
      }
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
      }
    },
    [],
  );

  const uploadFile = (file: File) => {
    const validationError = getClientValidationError(file);
    if (validationError) {
      setUpload(null);
      onError(validationError);
      return;
    }

    const token = readAccessToken();
    if (!token) {
      router.replace('/login');
      return;
    }

    onStart();
    setCanCancel(true);
    setUpload({ fileName: file.name, sizeBytes: file.size, progress: 0, phase: 'uploading' });

    const formData = new FormData();
    const extension = getExtension(file.name) as (typeof acceptedExtensions)[number];
    const uploadPayload =
      file.type === '' ? file.slice(0, file.size, allowedMimeTypes[extension][0]) : file;
    formData.append('file', uploadPayload, file.name);

    const request = new XMLHttpRequest();
    requestRef.current = request;
    request.open('POST', `${apiUrl}/meetings/${meetingId}/files`);
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.responseType = 'json';

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      const progress = Math.min(100, Math.round((event.loaded / event.total) * 100));
      setUpload((currentUpload) =>
        currentUpload
          ? {
              ...currentUpload,
              progress,
              phase: progress === 100 ? 'processing' : 'uploading',
            }
          : currentUpload,
      );
    };

    request.upload.onload = () => {
      setUpload((currentUpload) =>
        currentUpload ? { ...currentUpload, progress: 100, phase: 'processing' } : currentUpload,
      );
    };

    request.onload = () => {
      requestRef.current = null;
      setCanCancel(false);

      if (request.status === 401) {
        clearSessionIdentity();
        router.replace('/login');
        return;
      }

      setUpload((currentUpload) =>
        currentUpload ? { ...currentUpload, progress: 100, phase: 'processing' } : currentUpload,
      );

      completionTimerRef.current = window.setTimeout(() => {
        completionTimerRef.current = null;

        if (request.status < 200 || request.status >= 300) {
          setUpload((currentUpload) =>
            currentUpload ? { ...currentUpload, phase: 'error' } : currentUpload,
          );
          onError(getServerErrorMessage(request.status, request.response as UploadApiError | null));
          return;
        }

        const uploadedFile = request.response as MeetingFile | null;
        if (!uploadedFile?.id) {
          setUpload((currentUpload) =>
            currentUpload ? { ...currentUpload, phase: 'error' } : currentUpload,
          );
          onError('Сервер не подтвердил загрузку файла. Попробуйте ещё раз.');
          return;
        }

        setUpload((currentUpload) =>
          currentUpload ? { ...currentUpload, progress: 100, phase: 'success' } : currentUpload,
        );
        onUploaded(uploadedFile);
      }, minimumProcessingFeedbackMs);
    };

    request.onerror = () => {
      requestRef.current = null;
      setCanCancel(false);
      setUpload((currentUpload) =>
        currentUpload ? { ...currentUpload, phase: 'error' } : currentUpload,
      );
      onError('Не удалось загрузить файл. Проверьте соединение и попробуйте ещё раз.');
    };

    request.onabort = () => {
      requestRef.current = null;
      setCanCancel(false);
      setUpload((currentUpload) =>
        currentUpload ? { ...currentUpload, phase: 'cancelled' } : currentUpload,
      );
    };

    request.send(formData);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || isBusy) {
      return;
    }

    if (files.length !== 1) {
      setUpload(null);
      onError('Загружайте по одному файлу.');
      return;
    }

    uploadFile(files[0]);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <section
      aria-labelledby="meeting-upload-title"
      className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="meeting-upload-title" className="text-lg font-semibold text-slate-950">
            Загрузка файла
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Аудио, видео, транскрипты, PDF и DOCX — до 1 ГБ.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm ring-1 ring-slate-200">
          По одному файлу
        </span>
      </div>

      <div
        data-testid="upload-dropzone"
        onDragEnter={(event) => {
          event.preventDefault();
          if (!isBusy) {
            setIsDragging(true);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = isBusy ? 'none' : 'copy';
        }}
        onDragLeave={(event) => {
          const relatedTarget = event.relatedTarget;
          if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
            setIsDragging(false);
          }
        }}
        onDrop={handleDrop}
        className={`mt-4 rounded-2xl border-2 border-dashed px-5 py-7 text-center outline-none transition duration-200 focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2 sm:py-9 ${
          isDragging
            ? 'border-cyan-500 bg-cyan-50'
            : 'border-slate-300 bg-white hover:border-cyan-400 hover:bg-cyan-50/40'
        } ${isBusy ? 'cursor-wait opacity-70' : ''}`}
      >
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-cyan-100 text-cyan-800">
          <UploadIcon />
        </span>
        <p className="mt-4 font-semibold text-slate-950">Перетащите файл сюда</p>
        <p className="mt-1 text-sm text-slate-600">или выберите его на устройстве</p>
        <label
          className={`mt-4 inline-flex min-h-11 touch-manipulation items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition focus-within:ring-2 focus-within:ring-cyan-600 focus-within:ring-offset-2 ${
            isBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-slate-800'
          }`}
        >
          Выбрать файл
          <input
            type="file"
            accept={acceptValue}
            disabled={isBusy}
            aria-label="Выбрать файл"
            className="sr-only"
            onChange={handleInputChange}
          />
        </label>
      </div>

      {upload ? (
        <div aria-live="polite" className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-slate-950">{upload.fileName}</p>
              <p className="mt-1 text-xs text-slate-500">{formatFileSize(upload.sizeBytes)}</p>
            </div>
            {isBusy && canCancel ? (
              <button
                type="button"
                className="min-h-11 cursor-pointer touch-manipulation rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
                onClick={() => requestRef.current?.abort()}
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
              upload.phase === 'processing'
                ? 'Файл передан. Проверяем и сохраняем.'
                : `${upload.progress}%`
            }
            className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200"
          >
            <div
              className="h-full w-full origin-left rounded-full bg-cyan-600 transition-transform duration-200 motion-reduce:transition-none"
              style={{ transform: `scaleX(${upload.progress / 100})` }}
            />
          </div>
          <p className="mt-2 text-sm font-medium text-slate-700">{getPhaseMessage(upload)}</p>
        </div>
      ) : null}
    </section>
  );
}

function UploadIcon() {
  return (
    <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 16V5m0 0L8 9m4-4 4 4M5 15v4h14v-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
