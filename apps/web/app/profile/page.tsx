'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Profile = {
  email: string;
  displayName: string | null;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');

    if (!token) {
      router.replace('/login');
      return;
    }

    let isActive = true;

    const loadProfile = async () => {
      try {
        const response = await fetch(`${apiUrl}/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) {
          sessionStorage.removeItem('accessToken');
          sessionStorage.removeItem('userEmail');
          router.replace('/login');
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load profile');
        }

        const currentProfile = (await response.json()) as Profile;
        if (isActive) {
          setProfile(currentProfile);
        }
      } catch {
        if (isActive) {
          setLoadError('Не удалось загрузить профиль. Проверьте соединение и повторите попытку.');
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    void loadProfile();

    return () => {
      isActive = false;
    };
  }, [loadAttempt, router]);

  if (isLoading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-slate-950 text-white" aria-busy="true">
        <div className="text-center">
          <ProfileIcon className="mx-auto h-9 w-9 animate-pulse text-cyan-300 motion-reduce:animate-none" />
          <p className="mt-4 text-sm text-slate-300">Загружаем профиль…</p>
        </div>
      </main>
    );
  }

  if (loadError || !profile) {
    return (
      <main className="grid min-h-dvh place-items-center bg-slate-950 px-5 py-8 text-white sm:px-8">
        <section className="w-full max-w-lg rounded-3xl border border-red-300/20 bg-red-300/10 p-6 text-center shadow-xl shadow-slate-950/20 sm:p-8">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-red-300/10 text-red-200">
            <ProfileIcon className="h-6 w-6" />
          </span>
          <h1 className="mt-5 text-2xl font-semibold">Не удалось открыть профиль</h1>
          <p role="alert" className="mt-3 text-sm leading-6 text-red-100/80">
            {loadError ?? 'Профиль сейчас недоступен. Повторите попытку позже.'}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              className="min-h-11 touch-manipulation rounded-xl bg-white px-5 text-sm font-semibold text-slate-950 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
              onClick={() => {
                setLoadError(null);
                setIsLoading(true);
                setLoadAttempt((attempt) => attempt + 1);
              }}
            >
              Повторить
            </button>
            <Link
              href="/"
              className="inline-flex min-h-11 touch-manipulation items-center justify-center rounded-xl border border-white/20 px-5 text-sm font-semibold text-white transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
            >
              К встречам
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const displayName = profile.displayName?.trim() || 'Не указано';

  return (
    <main className="min-h-dvh bg-slate-950 px-5 py-5 text-white sm:px-8 sm:py-8">
      <div className="mx-auto max-w-4xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300 text-slate-950">
              <ProfileIcon className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold tracking-wide text-cyan-50">VIDEO MEETINGS</span>
          </div>
          <Link
            href="/"
            className="inline-flex min-h-11 touch-manipulation items-center justify-center rounded-xl border border-white/15 px-4 text-sm font-semibold text-slate-200 transition duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            К встречам
          </Link>
        </header>

        <section className="grid gap-6 py-10 lg:grid-cols-[1fr_0.9fr] lg:items-end lg:py-14">
          <div>
            <p className="text-sm font-semibold text-cyan-300">Учётная запись</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Профиль</h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
              Проверьте данные, с которыми вы входите и участвуете во встречах.
            </p>
          </div>
          <div className="rounded-3xl border border-cyan-200/15 bg-white/10 p-6 shadow-xl shadow-slate-950/20 backdrop-blur-sm">
            <p className="text-sm font-medium text-slate-300">Текущее имя</p>
            <p className="mt-3 break-words text-3xl font-semibold tracking-tight text-white">
              {displayName}
            </p>
          </div>
        </section>

        <section
          aria-labelledby="profile-details-title"
          className="rounded-3xl border border-slate-200 bg-white p-6 text-slate-950 shadow-xl shadow-slate-950/20 sm:p-8"
        >
          <p className="text-sm font-semibold text-cyan-700">Безопасные данные аккаунта</p>
          <h2 id="profile-details-title" className="mt-1 text-2xl font-semibold tracking-tight">
            Ваши данные
          </h2>
          <dl className="mt-7 divide-y divide-slate-200">
            <div className="grid gap-2 py-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center">
              <dt className="text-sm font-medium text-slate-600">Отображаемое имя</dt>
              <dd className="break-words text-base font-semibold text-slate-950">{displayName}</dd>
            </div>
            <div className="grid gap-2 py-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center">
              <dt className="text-sm font-medium text-slate-600">Email</dt>
              <dd>
                <output
                  aria-label="Email"
                  className="block w-full break-all rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-base leading-6 text-slate-700"
                >
                  {profile.email}
                </output>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Email используется только для входа и не редактируется в профиле.
                </p>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </main>
  );
}

function ProfileIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5.5 20a6.5 6.5 0 0 1 13 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
