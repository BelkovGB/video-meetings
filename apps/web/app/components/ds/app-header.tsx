'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogOut, Video } from 'lucide-react';

/** `href: null` renders the label as inert text — the section doesn't exist yet. */
type NavItem = { label: string; href: string | null };

type AppHeaderProps = {
  navItems: NavItem[];
  activeHref: string;
  userEmail: string;
  avatar: ReactNode;
  profileHref: string;
  onLogout: () => void;
};

export function AppHeader({
  navItems,
  activeHref,
  userEmail,
  avatar,
  profileHref,
  onLogout,
}: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-[var(--border-soft)] px-8 py-5 sm:px-16">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[linear-gradient(135deg,var(--accent-grad-from),var(--accent-grad-to))]">
          <Video className="h-[18px] w-[18px] text-[var(--accent-ink)]" strokeWidth={1.5} />
        </span>
        <span className="flex flex-col gap-px">
          <span className="font-display text-[17px] font-semibold tracking-[0.2px] text-[var(--text-primary)]">
            Meetspace
          </span>
          <span className="font-body text-[10.5px] tracking-[1.4px] text-[var(--text-muted)]">
            video meetings
          </span>
        </span>
      </div>
      <nav className="hidden items-center gap-7 md:flex">
        {navItems.map((item) =>
          item.href === null ? (
            <span
              key={item.label}
              className="font-body text-sm text-[var(--text-muted)]"
              aria-disabled="true"
            >
              {item.label}
            </span>
          ) : (
            <Link
              key={item.label}
              href={item.href}
              className={
                item.href === activeHref
                  ? 'font-body text-sm font-semibold text-[var(--text-primary)]'
                  : 'font-body text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }
            >
              {item.label}
            </Link>
          ),
        )}
      </nav>
      <div className="flex items-center gap-3">
        <Link
          href={profileHref}
          aria-label="Открыть профиль"
          className="flex items-center gap-2.5 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface)] py-1.5 pr-3.5 pl-1.5 transition-colors hover:border-[var(--accent-border)]"
        >
          {avatar}
          <span className="font-body text-[13px] text-[var(--text-secondary)]">{userEmail}</span>
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2 rounded-[var(--radius-pill)] border border-[var(--border)] px-3.5 py-[9px] font-body text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
          Выйти
        </button>
      </div>
    </header>
  );
}
