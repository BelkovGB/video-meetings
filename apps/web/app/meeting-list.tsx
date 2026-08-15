'use client';

import Link from 'next/link';
import type { Meeting } from '../lib/api/contracts';
import { formatMeetingDateShort } from '../lib/format/dates';
import { CalendarIcon } from './dashboard-icons';

type MeetingListProps = {
  meetings: Meeting[];
  onCreateMeeting: () => void;
};

type MeetingCardProps = {
  meeting: Meeting;
};

export function MeetingList({ meetings, onCreateMeeting }: MeetingListProps) {
  if (meetings.length === 0) {
    return (
      <div className="mt-6 rounded-2xl border border-dashed border-white/15 bg-slate-900/40 px-6 py-10 text-center">
        <p className="text-lg font-semibold">Встреч пока нет</p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-300">
          Создайте первую встречу, чтобы запланировать важный разговор и держать его под рукой.
        </p>
        <button
          type="button"
          className="mt-5 min-h-11 rounded-xl border border-cyan-200/20 bg-cyan-300/10 px-4 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/20 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-900"
          onClick={onCreateMeeting}
        >
          Создать первую встречу
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-3 lg:grid-cols-3">
      {meetings.map((meeting) => (
        <MeetingCard key={meeting.id} meeting={meeting} />
      ))}
    </div>
  );
}

function MeetingCard({ meeting }: MeetingCardProps) {
  return (
    <Link
      href={`/meetings/${meeting.id}`}
      aria-label={`Открыть встречу ${meeting.title}`}
      className="rounded-2xl border border-white/10 bg-slate-900/50 p-5 transition duration-200 hover:border-cyan-200/30 hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
    >
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300/10 text-cyan-200">
        <CalendarIcon />
      </span>
      <h3 className="mt-5 text-lg font-semibold text-white">{meeting.title}</h3>
      <p className="mt-2 text-sm text-slate-300">{formatMeetingDateShort(meeting.date)}</p>
      <span className="mt-4 inline-flex rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-100">
        {meeting.accessRole === 'owner' ? 'Владелец' : 'Участник'}
      </span>
    </Link>
  );
}
