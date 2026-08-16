'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, forwardRef, useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import type { ApiError } from '../../lib/api/contracts';
import { readAccessToken } from '../../lib/auth/session';

const minimumPasswordLength = 9;
const maximumPasswordBytes = 72;

type PasswordChangeFormProps = {
  onUnauthorized: () => void;
};

type PasswordField = 'currentPassword' | 'newPassword' | 'confirmation';
type PasswordErrors = Partial<Record<PasswordField, string>>;

function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value.normalize('NFC')).length;
}

function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): PasswordErrors {
  const errors: PasswordErrors = {};

  if (passwordByteLength(currentPassword) > maximumPasswordBytes) {
    errors.currentPassword = `Пароль не должен превышать ${maximumPasswordBytes} байта UTF-8.`;
  }

  if (Array.from(newPassword.normalize('NFC')).length < minimumPasswordLength) {
    errors.newPassword = `Используйте не менее ${minimumPasswordLength} символов.`;
  } else if (passwordByteLength(newPassword) > maximumPasswordBytes) {
    errors.newPassword = `Пароль не должен превышать ${maximumPasswordBytes} байта UTF-8.`;
  } else if (currentPassword && newPassword.normalize('NFC') === currentPassword.normalize('NFC')) {
    errors.newPassword = 'Новый пароль должен отличаться от текущего.';
  }

  if (confirmation !== newPassword) {
    errors.confirmation = 'Пароли не совпадают.';
  }

  return errors;
}

function getServerErrorField(message: string): PasswordField | null {
  const normalizedMessage = message.toLowerCase();
  if (normalizedMessage.includes('confirmation') || normalizedMessage.includes('confirm')) {
    return 'confirmation';
  }
  if (normalizedMessage.includes('newpassword') || normalizedMessage.includes('new password')) {
    return 'newPassword';
  }
  if (
    normalizedMessage.includes('currentpassword') ||
    normalizedMessage.includes('current password')
  ) {
    return 'currentPassword';
  }
  return null;
}

async function getPasswordChangeApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ApiError;
    if (typeof body.message === 'string') {
      return body.message;
    }
    if (Array.isArray(body.message) && body.message.length > 0) {
      return body.message[0];
    }
  } catch {
    // A malformed error response gets a safe, recoverable fallback.
  }

  return 'Не удалось изменить пароль. Проверьте соединение и повторите попытку.';
}

/** Changes the signed-in user's password while retaining field-level recovery feedback. */
export function PasswordChangeForm({ onUnauthorized }: PasswordChangeFormProps) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);

  const focusField = (field: PasswordField) => {
    const refs = {
      currentPassword: currentPasswordRef,
      newPassword: newPasswordRef,
      confirmation: confirmationRef,
    };
    requestAnimationFrame(() => refs[field].current?.focus());
  };

  useEffect(() => {
    const field = (['currentPassword', 'newPassword', 'confirmation'] as const).find(
      (name) => errors[name],
    );
    if (field && !isSubmitting) {
      focusField(field);
    }
  }, [errors, isSubmitting]);

  const clearErrors = (field: PasswordField) => {
    setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
    setRequestError(null);
  };

  const submitPasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const validationErrors = validatePasswordChange(currentPassword, newPassword, confirmation);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setRequestError(null);
      return;
    }

    const token = readAccessToken();
    if (!token) {
      router.replace('/login');
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    setRequestError(null);

    try {
      const response = await fetch(`${apiUrl}/users/me/password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword, newPassword, confirmation }),
      });

      if (response.status === 401) {
        onUnauthorized();
        return;
      }

      if (!response.ok) {
        const message = await getPasswordChangeApiError(response);
        const field = getServerErrorField(message);
        if (field) {
          setErrors({ [field]: message });
        } else {
          setRequestError(message);
          focusField('currentPassword');
        }
        return;
      }

      onUnauthorized();
    } catch {
      setRequestError('Не удалось изменить пароль. Проверьте соединение и повторите попытку.');
      focusField('currentPassword');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      className="grid gap-3 py-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start"
      onSubmit={submitPasswordChange}
      noValidate
      aria-busy={isSubmitting || undefined}
    >
      <div className="pt-3">
        <h3 className="text-sm font-medium text-slate-600">Пароль</h3>
      </div>
      <div>
        <div className="grid gap-4">
          <PasswordInput
            ref={currentPasswordRef}
            id="current-password"
            label="Текущий пароль"
            name="currentPassword"
            autoComplete="current-password"
            value={currentPassword}
            error={errors.currentPassword}
            disabled={isSubmitting}
            onChange={(value) => {
              setCurrentPassword(value);
              clearErrors('currentPassword');
            }}
          />
          <PasswordInput
            ref={newPasswordRef}
            id="new-password"
            label="Новый пароль"
            name="newPassword"
            autoComplete="new-password"
            value={newPassword}
            error={errors.newPassword}
            disabled={isSubmitting}
            onChange={(value) => {
              setNewPassword(value);
              clearErrors('newPassword');
            }}
          />
          <PasswordInput
            ref={confirmationRef}
            id="password-confirmation"
            label="Подтвердите новый пароль"
            name="confirmation"
            autoComplete="new-password"
            value={confirmation}
            error={errors.confirmation}
            disabled={isSubmitting}
            onChange={(value) => {
              setConfirmation(value);
              clearErrors('confirmation');
            }}
          />
        </div>
        <p id="password-change-help" className="mt-3 text-sm leading-6 text-slate-500">
          Не менее 9 символов и не более 72 байт UTF-8. После изменения потребуется войти снова.
        </p>
        {requestError ? (
          <p
            id="password-change-error"
            role="alert"
            className="mt-2 text-sm font-medium text-red-700"
          >
            {requestError}
          </p>
        ) : null}
        {isSubmitting ? (
          <p id="password-change-status" role="status" className="sr-only">
            Изменяем пароль…
          </p>
        ) : null}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-4 inline-flex min-h-11 touch-manipulation items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition duration-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
        >
          {isSubmitting ? 'Изменяем пароль…' : 'Изменить пароль'}
        </button>
      </div>
    </form>
  );
}

type PasswordInputProps = {
  id: string;
  label: string;
  name: string;
  autoComplete: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { id, label, name, autoComplete, value, error, disabled, onChange },
  ref,
) {
  const errorId = `${id}-error`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        name={name}
        type="password"
        autoComplete={autoComplete}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : 'password-change-help'}
        className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-700 focus:ring-2 focus:ring-cyan-700/25 disabled:cursor-wait disabled:bg-slate-100 disabled:text-slate-500"
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
});
