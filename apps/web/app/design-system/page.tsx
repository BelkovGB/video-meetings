'use client';

import { CalendarDays, ListChecks, Mic, Sparkles, Users } from 'lucide-react';

import { AgreementRow } from '../components/ds/agreement-row';
import { AppHeader } from '../components/ds/app-header';
import { RoleBadge, StatusPill, TaskStatusChip } from '../components/ds/badges';
import { Button } from '../components/ds/button';
import { DecisionRow } from '../components/ds/decision-row';
import { FileCard } from '../components/ds/file-card';
import { MeetingCard } from '../components/ds/meeting-card';
import { ParticipantRow } from '../components/ds/participant-row';
import { StatItem } from '../components/ds/stat-item';
import { Tab } from '../components/ds/tab';
import { TaskRow } from '../components/ds/task-row';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

export default function DesignSystemPage() {
  return (
    <div className="flex min-h-full flex-col">
      <AppHeader
        navItems={[
          { label: 'Встречи', href: '/' },
          { label: 'Записи', href: null },
          { label: 'Задачи', href: null },
        ]}
        activeHref="/"
        userEmail="123@123.ru"
        avatar={
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--surface-grad-to),var(--surface-grad-from))]">
            <span className="font-display text-xs font-semibold text-[var(--accent)]">1</span>
          </span>
        }
        profileHref="/profile"
        onLogout={() => {}}
      />
      <main className="flex flex-col gap-10 p-8 sm:p-16">
        <Section title="Кнопки">
          <Button variant="primary">Создать встречу</Button>
          <Button variant="secondary">Загрузить запись</Button>
          <Button variant="primary" disabled>
            Создать встречу
          </Button>
        </Section>

        <Section title="Вкладки">
          <div className="flex items-center gap-2 rounded-xl bg-[var(--surface)] p-1.5">
            <Tab label="Все" active />
            <Tab label="Мои" />
            <Tab label="Приглашения" />
          </div>
        </Section>

        <Section title="Статистика">
          <StatItem icon={Mic} value={3} label="записи" />
          <StatItem icon={Sparkles} value={2} label="саммари" />
          <StatItem icon={ListChecks} value={5} label="задач" />
        </Section>

        <Section title="Роли и статусы">
          <RoleBadge role="owner" />
          <RoleBadge role="participant" />
          <RoleBadge role="invited" />
          <RoleBadge role="guest" />
          <StatusPill status="ready" />
          <StatusPill status="processing" />
          <StatusPill status="recordingOnly" />
          <StatusPill status="error" />
          <TaskStatusChip status="inProgress" />
          <TaskStatusChip status="atRisk" />
          <TaskStatusChip status="overdue" />
          <TaskStatusChip status="done" />
        </Section>

        <Section title="Карточка встречи">
          <MeetingCard
            title="Синхрон по релизу"
            date="22 февраля в 11:11"
            role="owner"
            chips={[
              { icon: Mic, label: 'Запись' },
              { icon: Sparkles, label: 'Саммари' },
              { icon: ListChecks, label: '3 задачи' },
              { icon: Users, label: '12 участников' },
            ]}
            href="#"
          />
        </Section>

        <Section title="Карточка файла">
          <FileCard
            name="Запись_встречи_18-08.mp4"
            meta="1,4 ГБ · 47 мин · Анна Смирнова"
            status={{ kind: 'processing', label: 'Расшифровка…', percent: 60 }}
          />
          <FileCard
            name="Синк_по_продукту.mp4"
            meta="820 МБ · 32 мин · Андрей К."
            status={{ kind: 'done', label: 'Обработано' }}
          />
          <FileCard
            name="Битый_файл.mp4"
            meta="12 МБ · Мария С."
            status={{ kind: 'error', label: 'Ошибка загрузки' }}
          />
        </Section>

        <Section title="Строка задачи">
          <div className="flex w-full max-w-[760px] flex-col gap-3">
            <TaskRow
              title="Завершить интеграцию с платёжным провайдером"
              assignee="Андрей К."
              dueDate="до 1 марта"
              epic="Эпик · Прайсинг 2.0"
              story="Стори · PRJ-120"
              status="atRisk"
              jiraRef="Связана · PRJ-142"
            />
            <TaskRow
              title="Обновить лендинг"
              assignee="Оля Д."
              dueDate="до конца недели"
              status="done"
              done
            />
          </div>
        </Section>

        <Section title="Договорённость">
          <div className="flex w-full max-w-[760px] flex-col divide-y divide-[var(--border-soft)]">
            <AgreementRow
              initials="АК"
              who="Андрей К."
              what="завершит интеграцию с платёжным провайдером"
              dueDate="до 1 марта"
            />
            <AgreementRow
              initials="МС"
              who="Мария С."
              what="анонсирует прайсинг"
              dueDate="до 28 февраля"
            />
          </div>
        </Section>

        <Section title="Решение">
          <div className="flex w-full max-w-[760px] flex-col gap-3">
            <DecisionRow text="Релиз прайсинга переносится на 3 марта" />
            <DecisionRow text="Анонс выходит 28 февраля" />
          </div>
        </Section>

        <Section title="Участник">
          <div className="flex w-full max-w-[424px] flex-col divide-y divide-[var(--border-soft)]">
            <ParticipantRow
              initials="АК"
              name="Андрей К."
              role="Владелец"
              jiraLogin="@akuznetsov"
            />
            <ParticipantRow initials="МС" name="Мария С." role="Участник" />
          </div>
        </Section>

        <Section title="Показатели встречи">
          <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--accent-dim)] px-4 py-2">
            <CalendarDays className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
            <span className="font-body text-sm text-[var(--accent)]">
              Демонстрация иконок Lucide на токенах дизайн-системы
            </span>
          </div>
        </Section>
      </main>
    </div>
  );
}
