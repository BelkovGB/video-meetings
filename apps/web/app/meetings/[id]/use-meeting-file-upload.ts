'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useReducer, useRef } from 'react';

import { apiUrl } from '../../../lib/api/config';
import type { CodedApiError, MeetingFile } from '../../../lib/api/contracts';
import { sessionRejectedLoginPath } from '../../../lib/auth/login-notice';
import { clearSessionIdentity, readAccessToken } from '../../../lib/auth/session';

type MeetingFileUploadOptions = {
  meetingId: string;
  onUploaded: (file: MeetingFile) => void;
  onError: (message: string) => void;
  onStart: () => void;
};

/**
 * What the upload is doing, as one value.
 *
 * `running` is the only state that can still be cancelled: the request is in
 * flight. `finishing` covers the window between the server response and the
 * result, which the screen holds for `minimumProcessingFeedbackMs`, and the
 * expired-session redirect, which leaves the card on screen while the router
 * navigates away.
 */
type UploadStatus = 'running' | 'finishing' | 'success' | 'error' | 'cancelled';

export type UploadState = {
  status: UploadStatus;
  fileName: string;
  sizeBytes: number;
  progress: number;
};

/** What the card announces. `processing` means every byte is sent. */
export type UploadPhase = 'uploading' | 'processing' | 'success' | 'error' | 'cancelled';

type UploadEvent =
  | { type: 'started'; fileName: string; sizeBytes: number }
  | { type: 'progressed'; progress: number }
  | { type: 'transferred' }
  | { type: 'closed' }
  | { type: 'succeeded' }
  | { type: 'failed' }
  | { type: 'cancelled' }
  | { type: 'cleared' };

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
export const acceptValue = acceptedExtensions.join(',');
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

function getServerErrorMessage(status: number, error: CodedApiError | null): string {
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

function reduceUpload(upload: UploadState | null, event: UploadEvent): UploadState | null {
  if (event.type === 'started') {
    return {
      status: 'running',
      fileName: event.fileName,
      sizeBytes: event.sizeBytes,
      progress: 0,
    };
  }

  if (event.type === 'cleared') {
    return null;
  }

  if (!upload) {
    return upload;
  }

  switch (event.type) {
    case 'progressed':
      return upload.status === 'running' ? { ...upload, progress: event.progress } : upload;
    case 'transferred':
      return { ...upload, progress: 100 };
    case 'closed':
      return upload.status === 'running' ? { ...upload, status: 'finishing' } : upload;
    case 'succeeded':
      return { ...upload, status: 'success', progress: 100 };
    case 'failed':
      return { ...upload, status: 'error' };
    case 'cancelled':
      return { ...upload, status: 'cancelled' };
  }
}

export function getUploadPhase(upload: UploadState): UploadPhase {
  if (upload.status === 'running' || upload.status === 'finishing') {
    return upload.progress === 100 ? 'processing' : 'uploading';
  }

  return upload.status;
}

export function useMeetingFileUpload({
  meetingId,
  onUploaded,
  onError,
  onStart,
}: MeetingFileUploadOptions) {
  const router = useRouter();
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const [upload, dispatch] = useReducer(reduceUpload, null);
  const isBusy = upload?.status === 'running' || upload?.status === 'finishing';

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
      dispatch({ type: 'cleared' });
      onError(validationError);
      return;
    }

    const token = readAccessToken();
    if (!token) {
      router.replace('/login');
      return;
    }

    onStart();
    dispatch({ type: 'started', fileName: file.name, sizeBytes: file.size });

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
      dispatch({ type: 'progressed', progress });
    };

    request.upload.onload = () => {
      dispatch({ type: 'transferred' });
    };

    request.onload = () => {
      requestRef.current = null;
      dispatch({ type: 'closed' });

      if (request.status === 401) {
        clearSessionIdentity();
        router.replace(sessionRejectedLoginPath);
        return;
      }

      dispatch({ type: 'transferred' });

      completionTimerRef.current = window.setTimeout(() => {
        completionTimerRef.current = null;

        if (request.status < 200 || request.status >= 300) {
          dispatch({ type: 'failed' });
          onError(getServerErrorMessage(request.status, request.response as CodedApiError | null));
          return;
        }

        const uploadedFile = request.response as MeetingFile | null;
        if (!uploadedFile?.id) {
          dispatch({ type: 'failed' });
          onError('Сервер не подтвердил загрузку файла. Попробуйте ещё раз.');
          return;
        }

        dispatch({ type: 'succeeded' });
        onUploaded(uploadedFile);
      }, minimumProcessingFeedbackMs);
    };

    request.onerror = () => {
      requestRef.current = null;
      dispatch({ type: 'failed' });
      onError('Не удалось загрузить файл. Проверьте соединение и попробуйте ещё раз.');
    };

    request.onabort = () => {
      requestRef.current = null;
      dispatch({ type: 'cancelled' });
    };

    request.send(formData);
  };

  const uploadSelection = (files: FileList | null) => {
    if (!files || isBusy) {
      return;
    }

    if (files.length !== 1) {
      dispatch({ type: 'cleared' });
      onError('Загружайте по одному файлу.');
      return;
    }

    uploadFile(files[0]);
  };

  const cancelUpload = () => {
    requestRef.current?.abort();
  };

  return { upload, isBusy, uploadSelection, cancelUpload };
}
