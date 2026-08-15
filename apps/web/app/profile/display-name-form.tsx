'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import type { ApiError, CurrentUserProfile } from '../../lib/api/contracts';
import { readAccessToken, writeDisplayName } from '../../lib/auth/session';

type DisplayNameFormProps = {
  /** Seeds the field once; later profile updates leave the typed value alone. */
  initialDisplayName: string | null;
  onProfileSaved: (profile: CurrentUserProfile) => void;
  onUnauthorized: () => void;
};

export function DisplayNameForm({
  initialDisplayName,
  onProfileSaved,
  onUnauthorized,
}: DisplayNameFormProps) {
  const router = useRouter();
  const [displayNameInput, setDisplayNameInput] = useState(initialDisplayName ?? '');
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const displayNameInputRef = useRef<HTMLInputElement>(null);
  const saveStatusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (displayNameError && !isSaving) {
      requestAnimationFrame(() => displayNameInputRef.current?.focus());
    }
  }, [displayNameError, isSaving]);

  useEffect(() => {
    if (saveStatus) {
      requestAnimationFrame(() => saveStatusRef.current?.focus());
    }
  }, [saveStatus]);

  const submitDisplayName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedDisplayName = displayNameInput.trim();
    if (Array.from(trimmedDisplayName).length < 1 || Array.from(trimmedDisplayName).length > 100) {
      setDisplayNameError('Введите имя от 1 до 100 символов.');
      setSaveStatus(null);
      return;
    }

    const token = readAccessToken();
    if (!token) {
      router.replace('/login');
      return;
    }

    setIsSaving(true);
    setDisplayNameError(null);
    setSaveStatus(null);

    try {
      const response = await fetch(`${apiUrl}/users/me`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ displayName: trimmedDisplayName }),
      });

      if (response.status === 401) {
        onUnauthorized();
        return;
      }

      if (!response.ok) {
        setDisplayNameError(await getProfileApiError(response));
        return;
      }

      const updatedProfile = (await response.json()) as CurrentUserProfile;
      onProfileSaved(updatedProfile);
      setDisplayNameInput(updatedProfile.displayName ?? '');
      // Writes an empty string rather than removing the key; see writeDisplayName.
      writeDisplayName(updatedProfile.displayName ?? '');
      setSaveStatus(`Имя «${updatedProfile.displayName ?? ''}» сохранено.`);
    } catch {
      setDisplayNameError('Не удалось сохранить имя. Проверьте соединение и повторите попытку.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form
      className="grid gap-3 py-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start"
      onSubmit={submitDisplayName}
      noValidate
    >
      <label htmlFor="display-name" className="pt-3 text-sm font-medium text-slate-600">
        Отображаемое имя
      </label>
      <div>
        <input
          ref={displayNameInputRef}
          id="display-name"
          name="displayName"
          type="text"
          value={displayNameInput}
          maxLength={200}
          disabled={isSaving}
          aria-invalid={displayNameError ? true : undefined}
          aria-describedby={displayNameError ? 'display-name-error' : 'display-name-help'}
          className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-700 focus:ring-2 focus:ring-cyan-700/25 disabled:cursor-wait disabled:bg-slate-100 disabled:text-slate-500"
          onChange={(event) => {
            setDisplayNameInput(event.target.value);
            setDisplayNameError(null);
            setSaveStatus(null);
          }}
        />
        <p id="display-name-help" className="mt-2 text-sm leading-6 text-slate-500">
          От 1 до 100 символов. Пробелы в начале и конце не сохраняются.
        </p>
        {displayNameError ? (
          <p id="display-name-error" role="alert" className="mt-2 text-sm font-medium text-red-700">
            {displayNameError}
          </p>
        ) : null}
        {saveStatus ? (
          <p
            ref={saveStatusRef}
            id="display-name-status"
            role="status"
            tabIndex={-1}
            className="mt-2 text-sm font-medium text-emerald-700 outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2"
          >
            {saveStatus}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={isSaving}
          className="mt-4 inline-flex min-h-11 touch-manipulation items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition duration-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
        >
          {isSaving ? 'Сохраняем имя…' : 'Сохранить имя'}
        </button>
      </div>
    </form>
  );
}

/**
 * Reads the API error message. An array is used for field validation, and its
 * first element is returned even when empty, which renders an empty message.
 */
async function getProfileApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ApiError;
    if (typeof body.message === 'string') {
      return body.message;
    }
    if (Array.isArray(body.message) && body.message.length > 0) {
      return body.message[0];
    }
  } catch {
    // A malformed error response falls back to a recoverable field message.
  }

  return 'Не удалось сохранить имя. Исправьте значение и повторите попытку.';
}
