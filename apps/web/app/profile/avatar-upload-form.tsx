'use client';

import { useEffect, useRef } from 'react';

import type { Avatar } from '../../lib/api/contracts';
import { useAvatarActions } from './use-avatar-actions';

type AvatarUploadFormProps = {
  avatar: Avatar | null;
  onAvatarSaved: (avatar: Avatar) => void;
  onAvatarRemoved: () => void;
  onUnauthorized: () => void;
};

export function AvatarUploadForm({
  avatar,
  onAvatarSaved,
  onAvatarRemoved,
  onUnauthorized,
}: AvatarUploadFormProps) {
  const {
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
  } = useAvatarActions({ avatar, onAvatarSaved, onAvatarRemoved, onUnauthorized });
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error && !isUploading && !isRemoving) {
      requestAnimationFrame(() => {
        const target =
          errorFocusTarget === 'remove' ? removeButtonRef.current : fileInputRef.current;
        target?.focus();
      });
    }
  }, [error, errorFocusTarget, fileInputRef, isRemoving, isUploading]);

  useEffect(() => {
    if (status) {
      requestAnimationFrame(() => statusRef.current?.focus());
    }
  }, [status]);

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
          ref={fileInputRef}
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
