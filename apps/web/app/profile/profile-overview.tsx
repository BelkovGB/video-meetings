'use client';

import type { CurrentUserProfile } from '../../lib/api/contracts';
import { CurrentUserAvatar } from '../components/current-user-avatar';

type ProfileOverviewProps = {
  profile: CurrentUserProfile;
};

export function ProfileOverview({ profile }: ProfileOverviewProps) {
  const displayName = profile.displayName?.trim() || 'Не указано';

  return (
    <section className="grid gap-6 py-10 lg:grid-cols-[1fr_0.9fr] lg:items-end lg:py-14">
      <div>
        <p className="text-sm font-semibold text-cyan-300">Учётная запись</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Профиль</h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
          Проверьте данные, с которыми вы входите и участвуете во встречах.
        </p>
      </div>
      <div className="rounded-3xl border border-cyan-200/15 bg-white/10 p-6 shadow-xl shadow-slate-950/20 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <CurrentUserAvatar
            avatar={profile.avatar}
            displayName={profile.displayName}
            className="h-16 w-16 text-2xl"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-300">Текущее имя</p>
            <p className="mt-1 break-words text-3xl font-semibold tracking-tight text-white">
              {displayName}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
