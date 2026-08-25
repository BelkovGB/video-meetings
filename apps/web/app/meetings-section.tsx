'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';

import type { Meeting } from '../lib/api/contracts';
import { formatMeetingDateShort } from '../lib/format/dates';
import { MeetingCard } from './components/ds/meeting-card';
import { Tab } from './components/ds/tab';

type FilterKey = 'all' | 'owner' | 'participant';

const FILTERS: { key: FilterKey; label: string; title: string }[] = [
  { key: 'all', label: 'Все', title: 'Все встречи' },
  { key: 'owner', label: 'Мои', title: 'Мои встречи' },
  { key: 'participant', label: 'Приглашённые', title: 'Приглашённые встречи' },
];

function matchesFilter(meeting: Meeting, filter: FilterKey): boolean {
  if (filter === 'all') {
    return true;
  }

  return meeting.accessRole === filter;
}

type MeetingsSectionProps = {
  meetings: Meeting[];
  onCreateMeeting: () => void;
};

export function MeetingsSection({ meetings, onCreateMeeting }: MeetingsSectionProps) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const filteredMeetings = meetings.filter((meeting) => matchesFilter(meeting, filter));
  const activeFilter = FILTERS.find((item) => item.key === filter) ?? FILTERS[0];

  return (
    <section
      aria-labelledby="meetings-section-title"
      className="flex flex-col gap-6 px-8 pb-16 sm:px-16"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <span className="font-body text-[11px] font-semibold tracking-[1.2px] text-[var(--accent)]">
            РАБОЧАЯ ИСТОРИЯ
          </span>
          <div className="flex items-center gap-3">
            <h2
              id="meetings-section-title"
              className="font-display text-[28px] font-semibold text-[var(--text-primary)]"
            >
              {activeFilter.title}
            </h2>
            <span className="rounded-[var(--radius-pill)] bg-[var(--accent-dim)] px-2.5 py-1 font-display text-[13px] font-semibold text-[var(--accent)]">
              {filteredMeetings.length}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 self-start rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--surface)] p-1">
          {FILTERS.map((item) => (
            <Tab
              key={item.key}
              label={item.label}
              active={filter === item.key}
              onClick={() => setFilter(item.key)}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredMeetings.map((meeting) => (
          <MeetingCard
            key={meeting.id}
            title={meeting.title}
            date={formatMeetingDateShort(meeting.date)}
            role={meeting.accessRole}
            href={`/meetings/${meeting.id}`}
          />
        ))}
        <button
          type="button"
          onClick={onCreateMeeting}
          className="flex min-h-[193px] w-full flex-col items-center justify-center gap-2.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--overlay-bg)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-border)] hover:text-[var(--text-primary)]"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--surface-2)]">
            <Plus className="h-[18px] w-[18px] text-[var(--accent)]" strokeWidth={1.5} />
          </span>
          <span className="font-body text-sm font-medium">Новая встреча</span>
        </button>
      </div>
    </section>
  );
}
