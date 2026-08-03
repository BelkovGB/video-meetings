'use client';

import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIndicator,
  AlertTitle,
  Button,
  Input,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';

type Meeting = {
  id: string;
  title: string;
  date: string;
};

type ApiError = {
  message?: string | string[];
};

type FormErrors = {
  title?: string;
  date?: string;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getEmailFromToken(token: string) {
  try {
    const encodedPayload = token.split('.')[1];
    const normalizedPayload = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(
      atob(normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=')),
    ) as { email?: string };

    return payload.email ?? '';
  } catch {
    return '';
  }
}

function formatMeetingDate(date: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

function getApiErrorMessage(error: ApiError) {
  if (Array.isArray(error.message)) {
    return 'Проверьте название и дату встречи.';
  }

  return error.message ?? 'Не удалось выполнить запрос. Попробуйте ещё раз.';
}

export default function DashboardPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempts, setLoadAttempts] = useState(0);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});
  const [isCreating, setIsCreating] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');

    if (!token) {
      router.replace('/login');
      return;
    }

    setEmail(sessionStorage.getItem('userEmail') ?? getEmailFromToken(token));

    const loadMeetings = async () => {
      try {
        const response = await fetch(`${apiUrl}/meetings`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
          sessionStorage.removeItem('accessToken');
          sessionStorage.removeItem('userEmail');
          router.replace('/login');
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load meetings');
        }

        setMeetings((await response.json()) as Meeting[]);
      } catch {
        setLoadError('Не удалось загрузить встречи. Проверьте соединение и повторите попытку.');
      } finally {
        setIsLoading(false);
      }
    };

    void loadMeetings();
  }, [loadAttempts, router]);

  const retryLoadingMeetings = () => {
    setLoadError(null);
    setIsLoading(true);
    setLoadAttempts((currentAttempt) => currentAttempt + 1);
  };

  const logout = () => {
    sessionStorage.removeItem('accessToken');
    sessionStorage.removeItem('userEmail');
    router.replace('/login');
  };

  const validateTitle = () => {
    setFieldErrors((currentErrors) => ({
      ...currentErrors,
      title: title.trim() ? undefined : 'Введите название встречи.',
    }));
  };

  const validateDate = () => {
    setFieldErrors((currentErrors) => ({
      ...currentErrors,
      date: date ? undefined : 'Укажите дату и время встречи.',
    }));
  };

  const createMeeting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = sessionStorage.getItem('accessToken');

    if (!token) {
      router.replace('/login');
      return;
    }

    const nextFieldErrors: FormErrors = {
      title: title.trim() ? undefined : 'Введите название встречи.',
      date: date ? undefined : 'Укажите дату и время встречи.',
    };

    if (nextFieldErrors.title || nextFieldErrors.date) {
      setFieldErrors(nextFieldErrors);
      requestAnimationFrame(() => {
        if (nextFieldErrors.title) {
          titleInputRef.current?.focus();
          return;
        }

        dateInputRef.current?.focus();
      });
      return;
    }

    setSubmitError(null);
    setIsCreating(true);

    try {
      const response = await fetch(`${apiUrl}/meetings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: title.trim(), date: new Date(date).toISOString() }),
      });
      const data = (await response.json()) as Meeting & ApiError;

      if (!response.ok || !data.id) {
        setSubmitError(getApiErrorMessage(data));
        return;
      }

      setMeetings((currentMeetings) => [data, ...currentMeetings]);
      setTitle('');
      setDate('');
      setIsCreateOpen(false);
    } catch {
      setSubmitError('Не удалось создать встречу. Проверьте соединение и повторите попытку.');
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-slate-950 text-white">
        <Spinner color="current" size="lg" />
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-950 px-5 py-5 text-white sm:px-8 sm:py-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300 text-slate-950">
              <CameraIcon />
            </span>
            <span className="text-sm font-semibold tracking-wide text-cyan-50">VIDEO MEETINGS</span>
          </div>
          <button
            type="button"
            className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-semibold text-slate-200 transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
            onClick={logout}
          >
            Выйти из аккаунта
          </button>
        </header>

        <section className="grid gap-6 py-10 lg:grid-cols-[1.15fr_0.85fr] lg:py-14">
          <div>
            <p className="text-sm font-semibold text-cyan-300">Ваше рабочее пространство</p>
            <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
              Рады видеть вас, <span className="break-all">{email || 'коллега'}</span>.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
              Здесь собраны все ваши встречи: от первой идеи до следующего важного решения.
            </p>
            <Button
              type="button"
              className="mt-8 min-h-12 rounded-xl bg-cyan-300 px-5 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-400/15 transition hover:bg-cyan-200"
              onPress={() => {
                setSubmitError(null);
                setFieldErrors({});
                setIsCreateOpen(true);
              }}
            >
              Создать встречу
            </Button>
          </div>

          <section className="rounded-3xl border border-cyan-200/15 bg-white/10 p-6 shadow-xl shadow-slate-950/20 backdrop-blur-sm">
            <p className="text-sm font-medium text-slate-300">Всего встреч</p>
            <p className="mt-3 text-5xl font-semibold tracking-tight text-white">
              {meetings.length}
            </p>
            <p className="mt-4 text-sm leading-6 text-slate-300">
              {meetings.length === 0
                ? 'Создайте первую встречу — она сразу появится здесь.'
                : 'Все встречи доступны только из вашего аккаунта.'}
            </p>
          </section>
        </section>

        {loadError ? (
          <Alert
            role="alert"
            status="danger"
            className="mb-8 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-950 shadow-sm"
          >
            <AlertIndicator className="text-red-700" />
            <AlertContent className="gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <AlertTitle className="font-semibold text-red-950">
                  Не удалось загрузить встречи
                </AlertTitle>
                <AlertDescription className="text-sm text-red-800">{loadError}</AlertDescription>
              </div>
              <button
                type="button"
                className="min-h-11 shrink-0 rounded-xl border border-red-300 bg-white px-4 text-sm font-semibold text-red-800 transition hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-red-50"
                onClick={retryLoadingMeetings}
              >
                Повторить
              </button>
            </AlertContent>
          </Alert>
        ) : null}

        {isCreateOpen ? (
          <section
            aria-labelledby="create-meeting-title"
            className="mb-8 rounded-3xl border border-cyan-200/20 bg-white p-6 text-slate-950 shadow-xl sm:p-8"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="create-meeting-title" className="text-xl font-semibold">
                  Новая встреча
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Заполните детали — встреча появится в списке сразу после создания.
                </p>
              </div>
              <button
                type="button"
                className="grid h-11 w-11 place-items-center rounded-xl text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                aria-label="Закрыть форму создания встречи"
                onClick={() => {
                  setIsCreateOpen(false);
                  setSubmitError(null);
                  setFieldErrors({});
                }}
              >
                <CloseIcon />
              </button>
            </div>
            <form
              className="mt-6 grid gap-4 sm:grid-cols-[1fr_220px_auto] sm:items-end"
              noValidate
              onSubmit={createMeeting}
            >
              <TextField
                isInvalid={Boolean(fieldErrors.title)}
                isRequired
                fullWidth
                value={title}
                onChange={(value) => {
                  setTitle(value);
                  if (fieldErrors.title) {
                    setFieldErrors((currentErrors) => ({ ...currentErrors, title: undefined }));
                  }
                }}
              >
                <Label className="mb-2 text-sm font-medium text-slate-700">Название</Label>
                <Input
                  ref={titleInputRef}
                  autoComplete="off"
                  placeholder="Например, планирование спринта"
                  aria-describedby={fieldErrors.title ? 'meeting-title-error' : undefined}
                  onBlur={validateTitle}
                  className="h-12 rounded-xl border border-slate-200 bg-slate-50 px-4 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                />
                {fieldErrors.title ? (
                  <p
                    id="meeting-title-error"
                    role="alert"
                    className="mt-2 text-sm font-medium text-red-700"
                  >
                    {fieldErrors.title}
                  </p>
                ) : null}
              </TextField>
              <TextField
                isInvalid={Boolean(fieldErrors.date)}
                isRequired
                fullWidth
                value={date}
                onChange={(value) => {
                  setDate(value);
                  if (fieldErrors.date) {
                    setFieldErrors((currentErrors) => ({ ...currentErrors, date: undefined }));
                  }
                }}
                type="datetime-local"
              >
                <Label className="mb-2 text-sm font-medium text-slate-700">Дата и время</Label>
                <Input
                  ref={dateInputRef}
                  aria-describedby={fieldErrors.date ? 'meeting-date-error' : undefined}
                  onBlur={validateDate}
                  className="h-12 rounded-xl border border-slate-200 bg-slate-50 px-4 text-slate-950 outline-none transition focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                />
                {fieldErrors.date ? (
                  <p
                    id="meeting-date-error"
                    role="alert"
                    className="mt-2 text-sm font-medium text-red-700"
                  >
                    {fieldErrors.date}
                  </p>
                ) : null}
              </TextField>
              <Button
                type="submit"
                isDisabled={isCreating}
                className="h-12 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800"
              >
                {isCreating ? <Spinner size="sm" color="current" /> : 'Создать'}
              </Button>
            </form>
            {submitError ? (
              <Alert
                role="alert"
                status="danger"
                className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-950"
              >
                <AlertIndicator className="text-red-700" />
                <AlertContent>
                  <AlertDescription className="text-sm font-medium text-red-800">
                    {submitError}
                  </AlertDescription>
                </AlertContent>
              </Alert>
            ) : null}
          </section>
        ) : null}

        <section
          aria-labelledby="recent-meetings-title"
          className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 sm:p-8"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-cyan-300">Ближайшее и важное</p>
              <h2 id="recent-meetings-title" className="mt-1 text-2xl font-semibold tracking-tight">
                Последние встречи
              </h2>
            </div>
            <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-sm text-slate-300">
              Показано: {Math.min(meetings.length, 3)}
            </span>
          </div>

          {meetings.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-white/15 bg-slate-900/40 px-6 py-10 text-center">
              <p className="text-lg font-semibold">Встреч пока нет</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-300">
                Создайте первую встречу, чтобы запланировать важный разговор и держать его под
                рукой.
              </p>
              <button
                type="button"
                className="mt-5 min-h-11 rounded-xl border border-cyan-200/20 bg-cyan-300/10 px-4 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/20 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-900"
                onClick={() => {
                  setSubmitError(null);
                  setFieldErrors({});
                  setIsCreateOpen(true);
                }}
              >
                Создать первую встречу
              </button>
            </div>
          ) : (
            <div className="mt-6 grid gap-3 lg:grid-cols-3">
              {meetings.slice(0, 3).map((meeting) => (
                <article
                  key={meeting.id}
                  className="rounded-2xl border border-white/10 bg-slate-900/50 p-5 transition hover:border-cyan-200/30 hover:bg-slate-900"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300/10 text-cyan-200">
                    <CalendarIcon />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-white">{meeting.title}</h3>
                  <p className="mt-2 text-sm text-slate-300">{formatMeetingDate(meeting.date)}</p>
                </article>
              ))}
            </div>
          )}
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

function CalendarIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 3v4M16 3v4M4 10h16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}
