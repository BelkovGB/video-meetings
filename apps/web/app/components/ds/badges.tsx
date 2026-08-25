import {
  Bookmark,
  Layers,
  Link2,
  Loader,
  Mic,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

export type Role = 'owner' | 'participant' | 'invited' | 'guest';

const ROLE_LABEL: Record<Role, string> = {
  owner: 'ВЛАДЕЛЕЦ',
  participant: 'УЧАСТНИК',
  invited: 'ПРИГЛАШЁН',
  guest: 'ГОСТЬ',
};

const ROLE_CLASSES: Record<Role, string> = {
  owner: 'border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent)]',
  participant: 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)]',
  invited: 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)]',
  guest: 'border-[var(--border-soft)] bg-[var(--transparent)] text-[var(--text-muted)]',
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-pill)] border px-[10px] py-[5px] font-body text-[10px] font-semibold tracking-[1px] ${ROLE_CLASSES[role]}`}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

export type MeetingStatus = 'ready' | 'processing' | 'recordingOnly' | 'error';

const MEETING_STATUS_CONFIG: Record<
  MeetingStatus,
  { icon: LucideIcon; label: string; bg: string; text: string }
> = {
  ready: {
    icon: Sparkles,
    label: 'Саммари готово',
    bg: 'bg-[var(--accent-dim)]',
    text: 'text-[var(--accent)]',
  },
  processing: {
    icon: Loader,
    label: 'Обрабатываем',
    bg: 'bg-[var(--warning-soft)]',
    text: 'text-[var(--warning)]',
  },
  recordingOnly: {
    icon: Mic,
    label: 'Только запись',
    bg: 'bg-[var(--surface-2)]',
    text: 'text-[var(--text-secondary)]',
  },
  error: {
    icon: TriangleAlert,
    label: 'Ошибка загрузки',
    bg: 'bg-[var(--danger-soft)]',
    text: 'text-[var(--danger)]',
  },
};

export function StatusPill({ status, label }: { status: MeetingStatus; label?: string }) {
  const config = MEETING_STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-[var(--radius-pill)] px-4 py-[9px] font-body text-[13px] font-semibold ${config.bg} ${config.text}`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
      {label ?? config.label}
    </span>
  );
}

export type TaskStatus = 'inProgress' | 'atRisk' | 'overdue' | 'done';

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  inProgress: 'В работе',
  atRisk: 'Не успеваем',
  overdue: 'Просрочена',
  done: 'Готово',
};

const TASK_STATUS_CLASSES: Record<TaskStatus, string> = {
  inProgress: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  atRisk: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  overdue: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  done: 'bg-[var(--success-soft)] text-[var(--success)]',
};

const TASK_STATUS_DOT: Record<TaskStatus, string> = {
  inProgress: 'bg-[var(--accent)]',
  atRisk: 'bg-[var(--warning)]',
  overdue: 'bg-[var(--danger)]',
  done: 'bg-[var(--success)]',
};

export function TaskStatusChip({ status, label }: { status: TaskStatus; label?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-[11px] py-[5px] font-body text-[11.5px] font-semibold ${TASK_STATUS_CLASSES[status]}`}
    >
      <span className={`h-[5px] w-[5px] rounded-full ${TASK_STATUS_DOT[status]}`} />
      {label ?? TASK_STATUS_LABEL[status]}
    </span>
  );
}

export type TagVariant = 'epic' | 'story';

const TAG_CONFIG: Record<TagVariant, { icon: LucideIcon; bg: string; text: string }> = {
  epic: { icon: Layers, bg: 'bg-[var(--media-soft)]', text: 'text-[var(--media)]' },
  story: { icon: Bookmark, bg: 'bg-[var(--success-soft)]', text: 'text-[var(--success)]' },
};

export function TagChip({ variant, label }: { variant: TagVariant; label: string }) {
  const { icon: Icon, bg, text } = TAG_CONFIG[variant];
  return (
    <span
      className={`inline-flex items-center gap-[5px] rounded-[var(--radius-xs)] px-2 py-[3px] font-body text-[11px] font-medium ${bg} ${text}`}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={1.5} />
      {label}
    </span>
  );
}

export function LinkChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--info-border)] bg-[var(--info-soft)] px-3 py-1.5 font-body text-xs font-semibold text-[var(--info)]">
      <Link2 className="h-3 w-3" strokeWidth={1.5} />
      {label}
    </span>
  );
}

export function Chip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-[5px] rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-[10px] py-[5px] font-body text-xs font-medium text-[var(--text-secondary)]">
      <Icon className="h-3 w-3 text-[var(--accent)]" strokeWidth={1.5} />
      {label}
    </span>
  );
}
