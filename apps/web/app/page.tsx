'use client';

import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIndicator,
  AlertTitle,
  Spinner,
} from '@heroui/react';
import { useState } from 'react';
import { CurrentUserAvatar } from './components/current-user-avatar';
import { AppHeader } from './components/ds/app-header';
import { Tab } from './components/ds/tab';
import { CreateMeetingDialog } from './create-meeting-dialog';
import { DashboardHero } from './dashboard-hero';
import { MeetingsSection } from './meetings-section';
import { useDashboardData } from './use-dashboard-data';

const NAV_ITEMS = [
  { label: 'Встречи', href: '/' },
  { label: 'Записи', href: null },
  { label: 'Задачи', href: null },
];

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
      <main className="grid min-h-dvh place-items-center bg-[var(--bg)]">
        <Spinner color="current" size="lg" />
      </main>
    );
  }

  return (
    <main className="min-h-dvh">
      <AppHeader
        navItems={NAV_ITEMS}
        activeHref="/"
        userEmail={identity}
        avatar={
          <CurrentUserAvatar
            avatar={avatar}
            displayName={displayName}
            className="h-7 w-7 text-xs"
          />
        }
        profileHref="/profile"
        onLogout={logout}
      />

      <nav aria-label="Разделы приложения" className="flex items-center gap-2 px-8 pt-5 md:hidden">
        <Tab label="Встречи" active />
        <Tab label="Записи" disabled />
        <Tab label="Задачи" disabled />
      </nav>

      <DashboardHero
        identity={identity}
        meetingsCount={meetings.length}
        onCreateMeeting={openCreateMeeting}
      />

      {loadError ? (
        <div className="px-8 pb-8 sm:px-16">
          <Alert
            role="alert"
            status="danger"
            className="flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <AlertIndicator className="text-[var(--danger)]" />
            <AlertContent className="gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <AlertTitle className="font-semibold text-[var(--text-primary)]">
                  Не удалось загрузить встречи
                </AlertTitle>
                <AlertDescription className="text-sm text-[var(--text-secondary)]">
                  {loadError}
                </AlertDescription>
              </div>
              <button
                type="button"
                className="min-h-11 shrink-0 rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--danger)] transition hover:bg-[var(--danger-soft)]"
                onClick={retryLoadingMeetings}
              >
                Повторить
              </button>
            </AlertContent>
          </Alert>
        </div>
      ) : null}

      <CreateMeetingDialog
        isOpen={isCreateOpen}
        openRequestCount={createOpenRequestCount}
        onCreated={prependMeeting}
        onClose={() => {
          setIsCreateOpen(false);
        }}
      />

      <MeetingsSection meetings={meetings} onCreateMeeting={openCreateMeeting} />
    </main>
  );
}
