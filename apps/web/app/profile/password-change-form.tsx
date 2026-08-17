'use client';

import { FormEvent, forwardRef, useEffect, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import type { CodedApiError } from '../../lib/api/contracts';
import { readAccessToken } from '../../lib/auth/session';

const minimumPasswordLength = 9;
const maximumPasswordBytes = 72;

type PasswordChangeFormProps = {
  /** The session cannot authorize the change; the password is unchanged. */
  onSessionRejected: () => void;
  onPasswordChanged: () => void;
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

  // An empty field is caught here and never sent: the API counts a rate-limit
  // attempt in a guard, before the DTO is validated, so an accidental blank
  // submit would spend one of five attempts per fifteen minutes.
  if (!currentPassword) {
    errors.currentPassword = 'Введите текущий пароль.';
  } else if (passwordByteLength(currentPassword) > maximumPasswordBytes) {
    errors.currentPassword = `Пароль не должен превышать ${maximumPasswordBytes} байта UTF-8.`;
  }

  if (Array.from(newPassword.normalize('NFC')).length < minimumPasswordLength) {
    errors.newPassword = `Используйте не менее ${minimumPasswordLength} символов.`;
  } else if (passwordByteLength(newPassword) > maximumPasswordBytes) {
    errors.newPassword = `Пароль не должен превышать ${maximumPasswordBytes} байта UTF-8.`;
  } else if (currentPassword && newPassword.normalize('NFC') === currentPassword.normalize('NFC')) {
    errors.newPassword = 'Новый пароль должен отличаться от текущего.';
  }

  if (!confirmation) {
    errors.confirmation = 'Подтвердите новый пароль.';
  } else if (confirmation !== newPassword) {
    errors.confirmation = 'Пароли не совпадают.';
  }

  return errors;
}

/** A server rejection as the screen shows it: Russian text, and its field if any. */
type ServerError = { field: PasswordField | null; message: string };

const unknownServerError: ServerError = {
  field: null,
  message: 'Не удалось изменить пароль. Проверьте соединение и повторите попытку.',
};

// Server errors are routed by `code` and worded here, because everything else on
// this screen is Russian and the API answers in English. Matching its prose
// instead would unmark the field the moment a message is reworded.
// A `Map` rather than an object literal: both keys come off the wire, and a
// server-supplied `constructor` or `toString` would hit `Object.prototype` in a
// literal and resolve to an inherited function with no message to show.
const serverErrorsByCode = new Map<string, ServerError>([
  ['CURRENT_PASSWORD_INCORRECT', { field: 'currentPassword', message: 'Неверный текущий пароль.' }],
  [
    'NEW_PASSWORD_NOT_DIFFERENT',
    { field: 'newPassword', message: 'Новый пароль должен отличаться от текущего.' },
  ],
  ['PASSWORD_CONFIRMATION_MISMATCH', { field: 'confirmation', message: 'Пароли не совпадают.' }],
  [
    'PASSWORD_CHANGE_RATE_LIMITED',
    {
      field: null,
      message: 'Слишком много попыток изменить пароль. Повторите через несколько минут.',
    },
  ],
]);

// A `VALIDATION_FAILED` response names the rejected request properties instead.
// Local validation normally catches these first, so they are reached only when
// the two rule sets drift apart.
const serverErrorsByField = new Map<string, ServerError>([
  [
    'currentPassword',
    {
      field: 'currentPassword',
      message: `Введите текущий пароль не длиннее ${maximumPasswordBytes} байт UTF-8.`,
    },
  ],
  [
    'newPassword',
    {
      field: 'newPassword',
      message: `Используйте не менее ${minimumPasswordLength} символов и не более ${maximumPasswordBytes} байт UTF-8.`,
    },
  ],
  ['confirmation', { field: 'confirmation', message: 'Подтвердите новый пароль.' }],
]);

async function readServerError(response: Response): Promise<ServerError> {
  try {
    const body = (await response.json()) as CodedApiError;
    if (body.code === 'VALIDATION_FAILED') {
      for (const field of body.fields ?? []) {
        const rejection = serverErrorsByField.get(field);
        if (rejection) {
          return rejection;
        }
      }
    } else if (body.code) {
      const rejection = serverErrorsByCode.get(body.code);
      if (rejection) {
        return rejection;
      }
    }
  } catch {
    // A malformed error response gets a safe, recoverable fallback.
  }

  return unknownServerError;
}

/** Changes the signed-in user's password while retaining field-level recovery feedback. */
export function PasswordChangeForm({
  onSessionRejected,
  onPasswordChanged,
}: PasswordChangeFormProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // A rejection that belongs to no field returns the caret to a field all the
  // same, and a screen reader reads the description of the control it lands on.
  // Every field points at the message while it stands, so the refusal is heard
  // there instead of being left to an alert that mounts already filled — the
  // pattern the sign-in notice rejects because it is announced unreliably.
  const requestErrorId = requestError ? 'password-change-error' : undefined;
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const shouldFocusErrorRef = useRef(false);

  const focusField = (field: PasswordField) => {
    const refs = {
      currentPassword: currentPasswordRef,
      newPassword: newPasswordRef,
      confirmation: confirmationRef,
    };
    requestAnimationFrame(() => refs[field].current?.focus());
  };

  // Focus follows a rejected submit, never the error state itself: clearing one
  // field's error while another is still set would otherwise pull the caret out
  // of the field being typed into and append the rest of the value elsewhere.
  useEffect(() => {
    if (isSubmitting || !shouldFocusErrorRef.current) {
      return;
    }
    shouldFocusErrorRef.current = false;
    const field = (['currentPassword', 'newPassword', 'confirmation'] as const).find(
      (name) => errors[name],
    );
    if (field) {
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
      shouldFocusErrorRef.current = true;
      setErrors(validationErrors);
      setRequestError(null);
      return;
    }

    const token = readAccessToken();
    if (!token) {
      onSessionRejected();
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    setRequestError(null);
    let hasChanged = false;

    try {
      const response = await fetch(`${apiUrl}/users/me/password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword, newPassword, confirmation }),
      });

      // A `401` here is not only an expired token: the endpoint answers it for a
      // legacy session too, so a correct current password can land on it while
      // the password stays unchanged. Signing out is still the only recovery,
      // but it has to say so instead of dropping the user on a bare /login.
      if (response.status === 401) {
        onSessionRejected();
        return;
      }

      if (!response.ok) {
        const { field, message } = await readServerError(response);
        if (field) {
          shouldFocusErrorRef.current = true;
          setErrors({ [field]: message });
        } else {
          setRequestError(message);
          focusField('currentPassword');
        }
        return;
      }

      hasChanged = true;
      onPasswordChanged();
    } catch {
      setRequestError(unknownServerError.message);
      focusField('currentPassword');
    } finally {
      // A successful change leaves the form submitted while the router leaves
      // the page: re-enabling it would let a repeated Enter run again without a
      // token and replace the sign-out notice with the unchanged-password one.
      if (!hasChanged) {
        setIsSubmitting(false);
      }
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
            requestErrorId={requestErrorId}
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
            requestErrorId={requestErrorId}
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
            requestErrorId={requestErrorId}
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
  /** The id of the form-level error, while one is on screen. */
  requestErrorId?: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { id, label, name, autoComplete, value, error, requestErrorId, disabled, onChange },
  ref,
) {
  const errorId = `${id}-error`;
  // The refusal leads: a description is read after the label and can be cut
  // short, so the one new sentence must not sit behind guidance the user has
  // already heard on every earlier visit to this field.
  const describedBy = [requestErrorId, error ? errorId : 'password-change-help']
    .filter(Boolean)
    .join(' ');

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
        aria-describedby={describedBy}
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
