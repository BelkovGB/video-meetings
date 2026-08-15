'use client';

import { Alert, Button, FieldError, Input, Label, Spinner, TextField } from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useRef, useState } from 'react';

import { apiUrl } from '../../lib/api/config';
import { startSession } from '../../lib/auth/session';

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
  return value ? null : 'Введите пароль.';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextEmailError = validateEmail(email);
    const nextPasswordError = validatePassword(password);

    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setError(null);

    if (nextEmailError || nextPasswordError) {
      (nextEmailError ? emailInputRef : passwordInputRef).current?.focus();
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await response.json()) as { accessToken?: string };

      if (!response.ok || !data.accessToken) {
        setError('Не удалось войти. Проверьте email и пароль.');
        return;
      }

      startSession(data.accessToken, email);
      router.replace('/');
    } catch {
      setError('Нет соединения с сервером. Убедитесь, что API запущен, и повторите попытку.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-slate-950 px-5 py-8 text-white sm:p-8">
      <div className="absolute inset-0 -z-20 bg-[radial-gradient(circle_at_12%_16%,rgba(34,211,238,0.24),transparent_30%),radial-gradient(circle_at_88%_88%,rgba(129,140,248,0.28),transparent_32%),linear-gradient(135deg,#08111f_0%,#101b38_52%,#07111d_100%)]" />
      <section className="w-full max-w-md rounded-3xl border border-white/15 bg-white px-6 py-9 text-slate-950 shadow-2xl shadow-slate-950/50 sm:px-10 sm:py-12">
        <p className="text-sm font-semibold text-cyan-700">VIDEO MEETINGS</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">С возвращением</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Войдите, чтобы продолжить работу со встречами.
        </p>

        <form className="mt-8 space-y-5" noValidate onSubmit={submitLogin}>
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
            onChange={setEmail}
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
            onChange={setPassword}
            type="password"
          >
            <Label className="mb-2 text-sm font-medium text-slate-700">Пароль</Label>
            <Input
              ref={passwordInputRef}
              autoComplete="current-password"
              placeholder="Введите пароль"
              className="h-12 rounded-xl border border-slate-200 bg-slate-50 px-4 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
            />
            <div aria-live="polite">
              <FieldError className="mt-2 text-sm text-danger">{passwordError}</FieldError>
            </div>
          </TextField>

          {error ? (
            <Alert role="alert" status="danger" className="rounded-xl">
              {error}
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
                Входим…
              </span>
            ) : (
              'Войти'
            )}
          </Button>
        </form>

        <p className="mt-8 text-center text-sm text-slate-600">
          Нет аккаунта?{' '}
          <Link
            className="font-semibold text-cyan-700 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
            href="/register"
          >
            Создать аккаунт
          </Link>
        </p>
      </section>
    </main>
  );
}
