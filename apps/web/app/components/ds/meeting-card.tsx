import Link from 'next/link';
import { ArrowUpRight, Calendar, Clock4, type LucideIcon } from 'lucide-react';

import { Chip, RoleBadge, type Role } from './badges';

type MeetingCardChip = { icon: LucideIcon; label: string };

type MeetingCardProps = {
  title: string;
  date: string;
  role: Role;
  chips?: MeetingCardChip[];
  href: string;
};

export function MeetingCard({ title, date, role, chips = [], href }: MeetingCardProps) {
  return (
    <Link
      href={href}
      aria-label={`Открыть встречу ${title}`}
      className="flex w-full max-w-[424px] flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-6 transition-colors hover:border-[var(--accent-border)]"
    >
      <div className="flex items-center justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-[var(--accent-dim)]">
          <Calendar className="h-[18px] w-[18px] text-[var(--accent)]" strokeWidth={1.5} />
        </span>
        <RoleBadge role={role} />
      </div>
      <div className="flex flex-col gap-[7px]">
        <h3 className="font-display text-lg font-semibold text-[var(--text-primary)]">{title}</h3>
        <div className="flex items-center gap-[7px]">
          <Clock4 className="h-[13px] w-[13px] text-[var(--text-muted)]" strokeWidth={1.5} />
          <span className="font-body text-[13.5px] text-[var(--text-secondary)]">{date}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <Chip key={chip.label} icon={chip.icon} label={chip.label} />
          ))}
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
      </div>
    </Link>
  );
}
