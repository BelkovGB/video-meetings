'use client';

type TabProps = {
  label: string;
  active?: boolean;
  /** The section behind this tab doesn't exist yet — render inert, not clickable. */
  disabled?: boolean;
  onClick?: () => void;
};

export function Tab({ label, active = false, disabled = false, onClick }: TabProps) {
  if (disabled) {
    return (
      <span className="cursor-not-allowed rounded-[9px] px-3.5 py-[7px] font-body text-[13px] font-medium text-[var(--text-muted)]">
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'rounded-[9px] bg-[var(--surface-2)] px-3.5 py-[7px] font-body text-[13px] font-semibold text-[var(--text-primary)]'
          : 'rounded-[9px] px-3.5 py-[7px] font-body text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }
    >
      {label}
    </button>
  );
}
