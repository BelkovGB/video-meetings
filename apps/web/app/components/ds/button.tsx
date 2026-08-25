'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'font-semibold bg-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--shadow-glow)] hover:bg-[var(--accent-hover)] hover:shadow-[0_10px_40px_var(--glow-accent-strong)] active:bg-[var(--accent-press)] active:text-[var(--accent-ink-soft)] active:shadow-none disabled:border disabled:border-[var(--border-soft)] disabled:bg-[var(--surface-2)] disabled:text-[var(--text-muted)] disabled:shadow-none',
  secondary:
    'font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-2)] active:border-[var(--accent)] active:bg-[var(--bg)] active:text-[var(--text-primary)] disabled:border-[var(--border-soft)] disabled:bg-[var(--surface)] disabled:text-[var(--text-muted)]',
};

export function Button({
  variant = 'primary',
  icon,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-[9px] rounded-[var(--radius-md)] px-[var(--space-6)] py-[14px] font-body text-[15px] transition-colors disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
