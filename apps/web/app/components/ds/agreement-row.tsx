import { Calendar } from 'lucide-react';

type AgreementRowProps = {
  initials: string;
  who: string;
  what: string;
  dueDate: string;
};

export function AgreementRow({ initials, who, what, dueDate }: AgreementRowProps) {
  return (
    <div className="flex w-full flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex items-center justify-between gap-3 sm:contents">
        <div className="flex items-center gap-3">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--surface-grad-to),var(--surface-grad-from))]">
            <span className="font-display text-[10px] font-semibold text-[var(--accent)]">
              {initials}
            </span>
          </span>
          <span className="font-body text-sm font-semibold text-[var(--text-primary)] sm:hidden">
            {who}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-soft)] bg-[var(--surface-2)] px-[11px] py-[5px] font-body text-xs font-medium text-[var(--text-secondary)]">
          <Calendar className="h-[11px] w-[11px] text-[var(--accent)]" strokeWidth={1.5} />
          {dueDate}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="hidden font-body text-sm font-semibold text-[var(--text-primary)] sm:block">
          {who}
        </span>
        <p className="font-body text-[13.5px] leading-[1.4] text-[var(--text-secondary)]">{what}</p>
      </div>
    </div>
  );
}
