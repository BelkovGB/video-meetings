import type { LucideIcon } from 'lucide-react';

type StatItemProps = {
  icon: LucideIcon;
  value: string | number;
  label: string;
};

export function StatItem({ icon: Icon, value, label }: StatItemProps) {
  return (
    <div className="flex w-[107px] flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.5} />
        <span className="font-display text-xl font-semibold text-[var(--text-primary)]">
          {value}
        </span>
      </div>
      <span className="font-body text-[12.5px] text-[var(--text-muted)]">{label}</span>
    </div>
  );
}
