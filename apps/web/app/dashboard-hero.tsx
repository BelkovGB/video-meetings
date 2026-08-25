import { CalendarDays, Plus } from 'lucide-react';

import { Button } from './components/ds/button';

type DashboardHeroProps = {
  identity: string;
  meetingsCount: number;
  onCreateMeeting: () => void;
};

export function DashboardHero({ identity, meetingsCount, onCreateMeeting }: DashboardHeroProps) {
  return (
    <section className="flex flex-col items-start gap-10 px-8 pt-14 pb-12 sm:px-16 lg:flex-row lg:items-center lg:gap-16">
      <div className="flex w-full flex-col items-start gap-6">
        <span className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-[var(--accent-dim)] px-3 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          <span className="font-body text-[11px] font-semibold tracking-[1.2px] text-[var(--accent)]">
            ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО
          </span>
        </span>
        <h1 className="font-display text-4xl leading-[1.08] font-semibold tracking-[-1px] text-[var(--text-primary)] sm:text-5xl">
          Рады видеть вас.
          <span className="mt-2.5 block text-xl font-medium text-[var(--accent)] sm:text-2xl">
            {identity}
          </span>
        </h1>
        <p className="max-w-[520px] font-body text-base leading-[1.6] text-[var(--text-secondary)]">
          Здесь собраны все ваши встречи: от первой идеи до следующего важного решения. Загружайте
          записи, получайте краткие саммари и превращайте их в задачи.
        </p>
        <Button
          variant="primary"
          onClick={onCreateMeeting}
          icon={<Plus className="h-4 w-4" strokeWidth={1.5} />}
        >
          Создать встречу
        </Button>
      </div>
      <div className="flex w-full flex-col gap-[22px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[linear-gradient(160deg,var(--surface-3),var(--surface))] p-7 lg:w-[400px] lg:shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1.5">
            <span className="font-body text-[13px] font-medium tracking-[0.3px] text-[var(--text-secondary)]">
              Всего встреч
            </span>
            <span className="font-display text-[56px] leading-none font-semibold text-[var(--text-primary)]">
              {meetingsCount}
            </span>
          </div>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent-dim)]">
            <CalendarDays className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.5} />
          </span>
        </div>
        <p className="font-body text-[13px] leading-[1.5] text-[var(--text-muted)]">
          {meetingsCount === 0
            ? 'Создайте первую встречу — она сразу появится здесь.'
            : 'Здесь собраны ваши и приглашённые встречи.'}
        </p>
      </div>
    </section>
  );
}
