import Link from 'next/link';

export function MeetingFilesHeader() {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-white/10 pb-5">
      <Link
        href="/"
        className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-slate-200 transition duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-950"
      >
        <ArrowLeftIcon />
        Все встречи
      </Link>
      <span className="hidden text-sm font-semibold tracking-wide text-cyan-100 sm:block">
        VIDEO MEETINGS
      </span>
    </header>
  );
}

function ArrowLeftIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="m15 18-6-6 6-6M9 12h11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
