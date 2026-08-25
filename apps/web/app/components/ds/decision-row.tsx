import { CircleCheck } from 'lucide-react';

export function DecisionRow({ text }: { text: string }) {
  return (
    <div className="flex w-full items-start gap-2.5">
      <CircleCheck className="h-4 w-4 shrink-0 text-[var(--accent)]" strokeWidth={1.5} />
      <p className="font-body text-sm leading-[1.5] text-[var(--text-primary)]">{text}</p>
    </div>
  );
}
