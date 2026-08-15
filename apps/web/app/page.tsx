'use client';

import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIndicator,
  AlertTitle,
  Button,
  Spinner,
} from '@heroui/react';
import { useState } from 'react';
import { CreateMeetingDialog } from './create-meeting-dialog';
import { DashboardHeader } from './dashboard-header';
import { MeetingList } from './meeting-list';
import { useDashboardData } from './use-dashboard-data';

export default function DashboardPage() {
  const {
    identity,
    displayName,
    avatar,
    meetings,
    isLoading,
    loadError,
    prependMeeting,
    retryLoadingMeetings,
    logout,
  } = useDashboardData();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createOpenRequestCount, setCreateOpenRequestCount] = useState(0);

  const openCreateMeeting = () => {
    setCreateOpenRequestCount((currentCount) => currentCount + 1);
    setIsCreateOpen(true);
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
        <DashboardHeader avatar={avatar} displayName={displayName} onLogout={logout} />

        <section className="grid gap-6 py-10 lg:grid-cols-[1.15fr_0.85fr] lg:py-14">
          <div>
            <p className="text-sm font-semibold text-cyan-300">Ваше рабочее пространство</p>
            <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
              Рады видеть вас.
              <span className="mt-2 block break-words text-2xl leading-tight text-cyan-100 sm:text-3xl">
                {identity || 'коллега'}
              </span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
              Здесь собраны все ваши встречи: от первой идеи до следующего важного решения.
            </p>
            <Button
              type="button"
              className="mt-8 min-h-12 rounded-xl bg-cyan-300 px-5 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-400/15 transition hover:bg-cyan-200"
              onPress={openCreateMeeting}
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
                : 'Здесь собраны ваши и приглашённые встречи.'}
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

        <CreateMeetingDialog
          isOpen={isCreateOpen}
          openRequestCount={createOpenRequestCount}
          onCreated={prependMeeting}
          onClose={() => {
            setIsCreateOpen(false);
          }}
        />

        <section
          aria-labelledby="recent-meetings-title"
          className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 sm:p-8"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-cyan-300">Рабочая история</p>
              <h2 id="recent-meetings-title" className="mt-1 text-2xl font-semibold tracking-tight">
                Все встречи
              </h2>
            </div>
            <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-sm text-slate-300">
              Доступно: {meetings.length}
            </span>
          </div>

          <MeetingList meetings={meetings} onCreateMeeting={openCreateMeeting} />
        </section>
      </div>
    </main>
  );
}
