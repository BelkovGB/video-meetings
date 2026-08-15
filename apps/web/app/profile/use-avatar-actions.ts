'use client';

import { ChangeEvent, FormEvent, RefObject, useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import type { ApiError, Avatar } from '../../lib/api/contracts';
import { readAccessToken } from '../../lib/auth/session';

const maxAvatarBytes = 5 * 1024 * 1024;
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

type AvatarActionsOptions = {
  avatar: Avatar | null;
  onAvatarSaved: (avatar: Avatar) => void;
  onAvatarRemoved: () => void;
  onUnauthorized: () => void;
};

type AvatarActions = {
  file: File | null;
  previewUrl: string | null;
  error: string | null;
  errorFocusTarget: 'input' | 'remove';
  status: string | null;
  isUploading: boolean;
  isRemoving: boolean;
  /** Belongs to the actions because a successful upload clears the native value. */
  fileInputRef: RefObject<HTMLInputElement | null>;
  selectAvatar: (event: ChangeEvent<HTMLInputElement>) => void;
  uploadAvatar: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  removeAvatar: () => Promise<void>;
};

/** Holds the pending avatar selection and runs the upload and removal requests. */
export function useAvatarActions({
  avatar,
  onAvatarSaved,
  onAvatarRemoved,
  onUnauthorized,
}: AvatarActionsOptions): AvatarActions {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorFocusTarget, setErrorFocusTarget] = useState<'input' | 'remove'>('input');
  const [status, setStatus] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const selectAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] ?? null;
    setErrorFocusTarget('input');
    setError(null);
    setStatus(null);

    if (!selectedFile) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!acceptedTypes.has(selectedFile.type)) {
      setFile(null);
      setPreviewUrl(null);
      setError('Выберите изображение в формате JPEG, PNG или WebP.');
      return;
    }
    if (selectedFile.size > maxAvatarBytes) {
      setFile(null);
      setPreviewUrl(null);
      setError('Размер файла не должен превышать 5 МБ.');
      return;
    }

    setFile(selectedFile);
    setPreviewUrl(URL.createObjectURL(selectedFile));
  };

  const uploadAvatar = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) {
      setErrorFocusTarget('input');
      setError('Выберите изображение для загрузки.');
      return;
    }

    const token = readAccessToken();
    if (!token) {
      // A missing token ends the session here, unlike the guards that only redirect.
      onUnauthorized();
      return;
    }

    setIsUploading(true);
    setErrorFocusTarget('input');
    setError(null);
    setStatus(null);
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const response = await fetch(`${apiUrl}/users/me/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        setError(await getAvatarApiError(response));
        return;
      }

      const updatedAvatar = (await response.json()) as Avatar;
      onAvatarSaved(updatedAvatar);
      setFile(null);
      setPreviewUrl(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setStatus(avatar ? 'Аватар обновлён.' : 'Аватар сохранён.');
    } catch {
      setError('Не удалось загрузить аватар. Проверьте соединение и повторите попытку.');
    } finally {
      setIsUploading(false);
    }
  };

  const removeAvatar = async () => {
    const token = readAccessToken();
    if (!token) {
      // A missing token ends the session here, unlike the guards that only redirect.
      onUnauthorized();
      return;
    }

    setIsRemoving(true);
    setErrorFocusTarget('remove');
    setError(null);
    setStatus(null);
    try {
      const response = await fetch(`${apiUrl}/users/me/avatar`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        setError(
          await getAvatarApiError(response, 'Не удалось удалить аватар. Повторите попытку.'),
        );
        return;
      }

      onAvatarRemoved();
      setStatus('Аватар удалён.');
    } catch {
      setError('Не удалось удалить аватар. Проверьте соединение и повторите попытку.');
    } finally {
      setIsRemoving(false);
    }
  };

  return {
    file,
    previewUrl,
    error,
    errorFocusTarget,
    status,
    isUploading,
    isRemoving,
    fileInputRef,
    selectAvatar,
    uploadAvatar,
    removeAvatar,
  };
}

/**
 * Reads the API error message. An empty first array element falls back instead
 * of rendering an empty message, unlike the display name form.
 */
async function getAvatarApiError(
  response: Response,
  fallback = 'Не удалось загрузить аватар. Повторите попытку.',
) {
  try {
    const body = (await response.json()) as ApiError;
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message) && body.message[0]) return body.message[0];
  } catch {
    // The server response is not always JSON, but a field-level failure is still actionable.
  }
  return fallback;
}
