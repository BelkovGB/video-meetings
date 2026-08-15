'use client';

import Link from 'next/link';
import type { CurrentUserProfile } from '../lib/api/contracts';
import { CurrentUserAvatar } from './components/current-user-avatar';
import { CameraIcon } from './dashboard-icons';

type DashboardHeaderProps = {
  avatar: CurrentUserProfile['avatar'];
  displayName: string | null;
  onLogout: () => void;
};

export function DashboardHeader({ avatar, displayName, onLogout }: DashboardHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300 text-slate-950">
          <CameraIcon />
        </span>
        <span className="text-sm font-semibold tracking-wide text-cyan-50">VIDEO MEETINGS</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/profile"
          className="inline-flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-xl border border-white/15 px-3 text-sm font-semibold text-slate-200 transition duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
        >
          <CurrentUserAvatar
            avatar={avatar}
            displayName={displayName}
            className="h-7 w-7 text-xs"
          />
          Открыть профиль
        </Link>
        <button
          type="button"
          className="min-h-11 touch-manipulation rounded-xl border border-white/15 px-4 text-sm font-semibold text-slate-200 transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
          onClick={onLogout}
        >
          Выйти из аккаунта
        </button>
      </div>
    </header>
  );
}
