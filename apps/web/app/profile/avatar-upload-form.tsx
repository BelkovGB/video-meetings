'use client';

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import type { Avatar } from '../../lib/api/contracts';

type AvatarUploadFormProps = {
  avatar: Avatar | null;
  onAvatarSaved: (avatar: Avatar) => void;
  onAvatarRemoved: () => void;
  onUnauthorized: () => void;
};

const maxAvatarBytes = 5 * 1024 * 1024;
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function AvatarUploadForm({
  avatar,
  onAvatarSaved,
  onAvatarRemoved,
  onUnauthorized,
}: AvatarUploadFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorFocusTarget, setErrorFocusTarget] = useState<'input' | 'remove'>('input');
  const [status, setStatus] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (error && !isUploading && !isRemoving) {
      requestAnimationFrame(() => {
        const target = errorFocusTarget === 'remove' ? removeButtonRef.current : inputRef.current;
        target?.focus();
      });
    }
  }, [error, errorFocusTarget, isRemoving, isUploading]);

  useEffect(() => {
    if (status) {
      requestAnimationFrame(() => statusRef.current?.focus());
    }
  }, [status]);

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

    const token = sessionStorage.getItem('accessToken');
    if (!token) {
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
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      setStatus(avatar ? 'Аватар обновлён.' : 'Аватар сохранён.');
    } catch {
      setError('Не удалось загрузить аватар. Проверьте соединение и повторите попытку.');
    } finally {
      setIsUploading(false);
    }
  };

  const removeAvatar = async () => {
    const token = sessionStorage.getItem('accessToken');
    if (!token) {
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

  const isPending = isUploading || isRemoving;

  return (
    <form
      className="grid gap-3 py-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start"
      onSubmit={uploadAvatar}
      noValidate
    >
      <label htmlFor="avatar-upload" className="pt-3 text-sm font-medium text-slate-600">
        Выбрать файл аватара
      </label>
      <div data-testid="avatar-controls">
        <input
          ref={inputRef}
          id="avatar-upload"
          name="avatar"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={isPending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'avatar-upload-error' : 'avatar-upload-help'}
          className="block w-full cursor-pointer rounded-xl border border-slate-300 bg-white text-sm text-slate-700 file:mr-4 file:min-h-11 file:cursor-pointer file:border-0 file:bg-slate-950 file:px-4 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
          onChange={selectAvatar}
        />
        <p id="avatar-upload-help" className="mt-2 text-sm leading-6 text-slate-500">
          JPEG, PNG или WebP, не более 5 МБ.
        </p>
        {previewUrl ? (
          <div
            data-testid="avatar-preview-panel"
            className="mt-4 flex items-center gap-3 rounded-xl border border-cyan-200 bg-cyan-50 p-3"
          >
            <img
              data-testid="avatar-preview"
              src={previewUrl}
              alt="Предпросмотр нового аватара"
              className="h-16 w-16 rounded-full object-cover"
            />
            <p className="text-sm font-medium text-slate-700">Предпросмотр нового аватара</p>
          </div>
        ) : null}
        {error ? (
          <p
            id="avatar-upload-error"
            role="alert"
            className="mt-2 text-sm font-medium text-red-700"
          >
            {error}
          </p>
        ) : null}
        {status ? (
          <p
            ref={statusRef}
            id="avatar-upload-status"
            role="status"
            tabIndex={-1}
            className="mt-2 text-sm font-medium text-emerald-700 outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2"
          >
            {status}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!file || isPending}
          className="mt-4 inline-flex min-h-11 touch-manipulation items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition duration-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {isUploading ? 'Загружаем аватар…' : avatar ? 'Заменить аватар' : 'Загрузить аватар'}
        </button>
        {avatar ? (
          <button
            ref={removeButtonRef}
            type="button"
            disabled={isPending}
            className="mt-3 inline-flex min-h-11 w-[151px] touch-manipulation items-center justify-center rounded-xl border border-red-300 px-5 text-sm font-semibold text-red-700 transition duration-200 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2 disabled:cursor-wait disabled:border-slate-300 disabled:text-slate-400"
            onClick={() => void removeAvatar()}
          >
            {isRemoving ? 'Удаляем аватар…' : 'Удалить аватар'}
          </button>
        ) : null}
      </div>
    </form>
  );
}

async function getAvatarApiError(
  response: Response,
  fallback = 'Не удалось загрузить аватар. Повторите попытку.',
) {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message) && body.message[0]) return body.message[0];
  } catch {
    // The server response is not always JSON, but a field-level failure is still actionable.
  }
  return fallback;
}
