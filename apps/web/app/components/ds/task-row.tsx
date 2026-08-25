import { Calendar, Circle, CircleCheck, User } from 'lucide-react';

import { LinkChip, TagChip, TaskStatusChip, type TaskStatus } from './badges';

type TaskRowProps = {
  title: string;
  assignee: string;
  dueDate: string;
  done?: boolean;
  epic?: string;
  story?: string;
  status: TaskStatus;
  jiraRef?: string;
};

export function TaskRow({
  title,
  assignee,
  dueDate,
  done = false,
  epic,
  story,
  status,
  jiraRef,
}: TaskRowProps) {
  const CheckIcon = done ? CircleCheck : Circle;
  const hasRefs = Boolean(epic || story);

  return (
    <div className="flex w-full flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--surface-2)] p-4 sm:flex-row sm:items-center sm:gap-3.5">
      <div className="flex items-start gap-3 sm:contents">
        <CheckIcon
          className="h-[18px] w-[18px] shrink-0 text-[var(--text-muted)]"
          strokeWidth={1.5}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p
            className={`font-body text-[14.5px] font-medium ${done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'}`}
          >
            {title}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 font-body text-xs text-[var(--text-muted)]">
              <User className="h-[11px] w-[11px]" strokeWidth={1.5} />
              {assignee}
            </span>
            <span className="flex items-center gap-1.5 font-body text-xs text-[var(--text-muted)]">
              <Calendar className="h-[11px] w-[11px]" strokeWidth={1.5} />
              {dueDate}
            </span>
          </div>
          {hasRefs && (
            <div className="flex items-center gap-2">
              {epic && <TagChip variant="epic" label={epic} />}
              {story && <TagChip variant="story" label={story} />}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 sm:justify-end sm:gap-3.5">
        <TaskStatusChip status={status} />
        {jiraRef && <LinkChip label={jiraRef} />}
      </div>
    </div>
  );
}
