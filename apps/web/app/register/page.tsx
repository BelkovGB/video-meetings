'use client';

import { Alert, Button, FieldError, Input, Label, Spinner, TextField } from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useRef, useState } from 'react';

type ApiError = {
  message?: string | string[];
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const minimumPasswordLength = 9;
const maximumPasswordBytes = 72;

function validateEmail(value: string) {
  const normalizedEmail = value.trim();

  if (!normalizedEmail) {
    return 'Введите email.';
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return 'Введите email в формате name@company.com.';
  }

  return null;
}

function validatePassword(value: string) {
  if (!value) {
    return 'Введите пароль.';
  }

  if (Array.from(value).length < minimumPasswordLength) {
    return `Используйте не менее ${minimumPasswordLength} символов.`;
  }

  if (new TextEncoder().encode(value).length > maximumPasswordBytes) {
    return 'Пароль слишком длинный. Используйте не более 72 байт.';
  }

  return null;
}

function getErrorMessage(error: ApiError, status: number) {
  if (status === 409) {
    return 'Этот email уже зарегистрирован.';
  }

  if (Array.isArray(error.message)) {
    return 'Проверьте корректность email и пароля.';
  }

  return error.message ?? 'Не удалось создать аккаунт. Попробуйте ещё раз.';
}

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isEmailTouched, setIsEmailTouched] = useState(false);
  const [isPasswordTouched, setIsPasswordTouched] = useState(false);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isExistingAccount, setIsExistingAccount] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const updateEmail = (value: string) => {
    setEmail(value);
    setError(null);

    if (isEmailTouched) {
      setEmailError(validateEmail(value));
    }
  };

  const updatePassword = (value: string) => {
    setPassword(value);
    setError(null);

    if (isPasswordTouched) {
      setPasswordError(validatePassword(value));
    }
  };

  const validateForm = () => {
    const nextEmailError = validateEmail(email);
    const nextPasswordError = validatePassword(password);

    setIsEmailTouched(true);
    setIsPasswordTouched(true);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);

    if (nextEmailError) {
      emailInputRef.current?.focus();
    } else if (nextPasswordError) {
      passwordInputRef.current?.focus();
    }

    return !nextEmailError && !nextPasswordError;
  };

  const submitRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsRegistered(false);
    setIsExistingAccount(false);

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(`${apiUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = (await response.json()) as { accessToken?: string } & ApiError;

      if (!response.ok || !data.accessToken) {
        setIsExistingAccount(response.status === 409);
        setError(getErrorMessage(data, response.status));
        return;
      }

      sessionStorage.setItem('accessToken', data.accessToken);
      sessionStorage.setItem('userEmail', email.trim().toLowerCase());
      sessionStorage.removeItem('userDisplayName');
      router.replace('/');
    } catch {
      setError('Нет соединения с сервером. Убедитесь, что API запущен, и повторите попытку.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative isolate flex min-h-dvh overflow-hidden bg-slate-950 px-5 py-8 text-white sm:items-center sm:justify-center sm:p-8">
      <div className="absolute inset-0 -z-20 bg-[radial-gradient(circle_at_14%_12%,rgba(34,211,238,0.24),transparent_29%),radial-gradient(circle_at_86%_82%,rgba(129,140,248,0.28),transparent_32%),linear-gradient(135deg,#08111f_0%,#101b38_52%,#07111d_100%)]" />
      <div className="absolute -left-28 top-1/2 -z-10 h-80 w-80 -translate-y-1/2 rounded-full bg-cyan-400/20 blur-3xl" />
      <div className="absolute -right-24 top-12 -z-10 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />

      <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-white/15 bg-white/10 shadow-2xl shadow-slate-950/50 backdrop-blur-xl lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden min-h-[640px] overflow-hidden border-r border-white/10 p-12 lg:block">
          <div className="absolute inset-0 bg-[linear-gradient(145deg,rgba(34,211,238,0.12),transparent_42%,rgba(129,140,248,0.2))]" />
          <div className="relative flex h-full flex-col">
            <div className="flex items-center gap-3 text-sm font-semibold tracking-wide text-cyan-100">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-300 text-slate-950 shadow-lg shadow-cyan-400/20">
                <CameraIcon />
              </span>
              VIDEO MEETINGS
            </div>

            <div className="my-auto max-w-sm">
              <p className="mb-5 inline-flex rounded-full border border-cyan-200/20 bg-cyan-200/10 px-3 py-1 text-xs font-medium text-cyan-100">
                Пространство для вашей команды
              </p>
              <h1 className="text-5xl font-semibold leading-[1.05] tracking-tight text-white">
                Встречайтесь. Решайте. Двигайтесь дальше.
              </h1>
              <p className="mt-6 text-base leading-7 text-slate-300">
                Создавайте встречи и держите все важные договорённости в одном спокойном месте.
              </p>
            </div>

            <div className="flex items-center gap-3 text-sm text-slate-300">
              <span className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-white/10 text-cyan-200">
                <CheckIcon />
              </span>
              Ваши встречи доступны только вам.
            </div>
          </div>
        </section>

        <section className="bg-white px-6 py-9 text-slate-950 sm:px-10 sm:py-12">
          <div className="mx-auto w-full max-w-sm">
            <div className="mb-10 flex items-center gap-3 lg:hidden">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300 text-slate-950">
                <CameraIcon />
              </span>
              <span className="text-sm font-semibold tracking-wide text-slate-900">
                VIDEO MEETINGS
              </span>
            </div>

            <p className="text-sm font-semibold text-cyan-700">Начните бесплатно</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Создайте аккаунт
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              Всего пара деталей — и можно планировать первую встречу.
            </p>

            <form className="mt-8 space-y-5" noValidate onSubmit={submitRegistration}>
              {emailError || passwordError ? (
                <Alert role="alert" status="danger" className="rounded-xl">
                  Исправьте выделенные поля и повторите попытку.
                </Alert>
              ) : null}

              <TextField
                isRequired
                fullWidth
                isInvalid={Boolean(emailError)}
                value={email}
                onBlur={() => {
                  setIsEmailTouched(true);
                  setEmailError(validateEmail(email));
                }}
                onChange={updateEmail}
                type="email"
              >
                <Label className="mb-2 text-sm font-medium text-slate-700">Email</Label>
                <Input
                  ref={emailInputRef}
                  autoComplete="email"
                  placeholder="you@company.com"
                  className="h-12 rounded-xl border border-slate-200 bg-slate-50 px-4 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                />
                <div aria-live="polite">
                  <FieldError className="mt-2 text-sm text-danger">{emailError}</FieldError>
                </div>
              </TextField>

              <TextField
                isRequired
                fullWidth
                isInvalid={Boolean(passwordError)}
                value={password}
                onBlur={() => {
                  setIsPasswordTouched(true);
                  setPasswordError(validatePassword(password));
                }}
                onChange={updatePassword}
                type={isPasswordVisible ? 'text' : 'password'}
              >
                <Label className="mb-2 text-sm font-medium text-slate-700">Пароль</Label>
                <div className="relative">
                  <Input
                    ref={passwordInputRef}
                    autoComplete="new-password"
                    placeholder="Придумайте пароль"
                    className="h-12 rounded-xl border border-slate-200 bg-slate-50 px-4 pr-20 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                  />
                  <button
                    type="button"
                    aria-label={isPasswordVisible ? 'Скрыть пароль' : 'Показать пароль'}
                    className="absolute right-1 top-1/2 flex h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-md px-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-50 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
                    onClick={() => setIsPasswordVisible((isVisible) => !isVisible)}
                  >
                    {isPasswordVisible ? 'Скрыть' : 'Показать'}
                  </button>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Не менее 9 символов. Подходят пробелы, Unicode и менеджеры паролей.
                </p>
                <div aria-live="polite">
                  <FieldError className="mt-2 text-sm text-danger">{passwordError}</FieldError>
                </div>
              </TextField>

              {error ? (
                <Alert role="alert" status="danger" className="rounded-xl">
                  <div className="space-y-2">
                    <p>{error}</p>
                    {isExistingAccount ? (
                      <Link
                        className="font-semibold text-danger underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-2"
                        href="/login"
                      >
                        Перейти ко входу
                      </Link>
                    ) : null}
                  </div>
                </Alert>
              ) : null}

              {isRegistered ? (
                <Alert role="status" status="success" className="rounded-xl">
                  Аккаунт создан — доступ для работы со встречами сохранён.
                </Alert>
              ) : null}

              <Button
                type="submit"
                fullWidth
                isDisabled={isSubmitting}
                className="h-12 rounded-xl bg-slate-950 text-sm font-semibold text-white shadow-lg shadow-slate-900/20 transition hover:bg-slate-800 disabled:opacity-70"
              >
                {isSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner size="sm" color="current" />
                    Создаём аккаунт…
                  </span>
                ) : (
                  'Создать аккаунт'
                )}
              </Button>
            </form>

            <p className="mt-8 text-center text-xs leading-5 text-slate-600">
              Продолжая, вы соглашаетесь на безопасное хранение данных вашего аккаунта.
            </p>
            <p className="mt-4 text-center text-sm text-slate-600">
              Уже есть аккаунт?{' '}
              <Link
                className="font-semibold text-cyan-700 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
                href="/login"
              >
                Войти
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function CameraIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M4 7.8A1.8 1.8 0 0 1 5.8 6h7.4A1.8 1.8 0 0 1 15 7.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 16.2V7.8Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="m15 10.1 4.2-2.3c.8-.4 1.8.1 1.8 1v6.4c0 .9-1 1.4-1.8 1L15 13.9v-3.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="m5 12.5 4.2 4.2L19 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
    </svg>
  );
}
