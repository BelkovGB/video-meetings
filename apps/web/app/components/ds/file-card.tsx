import { CircleCheck, TriangleAlert, Video } from 'lucide-react';

type FileCardStatus =
  | { kind: 'processing'; label: string; percent: number }
  | { kind: 'done'; label: string }
  | { kind: 'error'; label: string };

type FileCardProps = {
  name: string;
  meta: string;
  status: FileCardStatus;
};

export function FileCard({ name, meta, status }: FileCardProps) {
  return (
    <div className="flex w-full max-w-[472px] gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-dim)]">
        <Video className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.5} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="truncate font-body text-sm font-semibold text-[var(--text-primary)]">
          {name}
        </p>
        <p className="truncate font-body text-xs text-[var(--text-secondary)]">{meta}</p>
        {status.kind === 'processing' && (
          <>
            <div className="flex items-center justify-between pt-0.5">
              <span className="font-body text-xs text-[var(--accent)]">{status.label}</span>
              <span className="font-body text-xs font-semibold text-[var(--accent)]">
                {status.percent}%
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-1 rounded-full bg-[var(--accent)]"
                style={{ width: `${status.percent}%` }}
              />
            </div>
          </>
        )}
        {status.kind === 'done' && (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--accent-dim)] px-2.5 py-1 font-body text-xs font-semibold text-[var(--accent)]">
            <CircleCheck className="h-[13px] w-[13px]" strokeWidth={1.5} />
            {status.label}
          </span>
        )}
        {status.kind === 'error' && (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--danger-soft)] px-2.5 py-1 font-body text-xs font-semibold text-[var(--danger)]">
            <TriangleAlert className="h-[13px] w-[13px]" strokeWidth={1.5} />
            {status.label}
          </span>
        )}
      </div>
    </div>
  );
}
