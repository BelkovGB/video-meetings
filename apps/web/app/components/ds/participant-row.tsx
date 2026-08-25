import { LinkChip } from './badges';

type ParticipantRowProps = {
  initials: string;
  name: string;
  role: string;
  jiraLogin?: string;
};

export function ParticipantRow({ initials, name, role, jiraLogin }: ParticipantRowProps) {
  return (
    <div className="flex w-full items-center gap-3 py-[11px]">
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--surface-grad-to),var(--surface-grad-from))]">
        <span className="font-display text-[11px] font-semibold text-[var(--accent)]">
          {initials}
        </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate font-body text-sm font-medium text-[var(--text-primary)]">{name}</p>
        <p className="truncate font-body text-xs text-[var(--text-muted)]">{role}</p>
      </div>
      {jiraLogin && <LinkChip label={jiraLogin} />}
    </div>
  );
}
