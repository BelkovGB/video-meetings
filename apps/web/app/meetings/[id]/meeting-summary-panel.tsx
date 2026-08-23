'use client';

import { Spinner } from '@heroui/react';

import { summaryFailureReason, summaryStatusLabel } from './summary-status';
import { useMeetingSummary } from './use-meeting-summary';

type MeetingSummaryPanelProps = {
  meetingId: string;
  hasTranscript: boolean;
};

export function MeetingSummaryPanel({ meetingId, hasTranscript }: MeetingSummaryPanelProps) {
  const { summary, isStarting, startError, startSummary } = useMeetingSummary(meetingId);
  const { status, failureCode } = summary;
  const isRunning = status === 'queued' || status === 'processing';
  const buttonLabel = status === 'error' ? 'Повторить' : 'Обновить выжимку';

  return (
    <section
      aria-labelledby="meeting-summary-title"
      className="rounded-3xl border border-slate-200 bg-white p-5 text-slate-950 shadow-2xl shadow-black/20 sm:p-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <p className="text-sm font-semibold text-cyan-700">Итог встречи</p>
          <h2 id="meeting-summary-title" className="mt-1 text-2xl font-semibold tracking-tight">
            Выжимка встречи
          </h2>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!hasTranscript || isStarting || isRunning}
          className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition duration-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void startSummary()}
        >
          {isStarting ? <Spinner size="sm" color="current" /> : null}
          {buttonLabel}
        </button>
        {!hasTranscript ? (
          <span data-testid="summary-start-hint" className="text-sm text-slate-600">
            Ждём расшифровку.
          </span>
        ) : null}
      </div>

      {status === 'queued' || status === 'processing' || status === 'error' ? (
        <div className="mt-4 space-y-1">
          <p data-testid="summary-status" className="text-sm font-medium text-slate-700">
            {summaryStatusLabel(status)}
          </p>
          {status === 'error' && failureCode ? (
            <p data-testid="summary-failure-reason" className="text-sm text-red-700">
              {summaryFailureReason(failureCode)}
            </p>
          ) : null}
        </div>
      ) : null}

      {status === 'ready' ? (
        <div className="mt-4 space-y-6">
          <div>
            <h3 className="text-base font-semibold tracking-tight text-slate-950">
              Краткое содержание
            </h3>
            {summary.summary ? (
              <p
                data-testid="summary-text"
                className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800"
              >
                {summary.summary}
              </p>
            ) : null}
          </div>

          {summary.tasks.length > 0 ? (
            <div>
              <h3 className="text-base font-semibold tracking-tight text-slate-950">Задачи</h3>
              <ul data-testid="summary-tasks" className="mt-2 space-y-3">
                {summary.tasks.map((task) => (
                  <li
                    key={task.id}
                    data-testid="summary-task"
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <p className="break-words font-medium text-slate-950">{task.title}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Ответственный:{' '}
                      {task.assignee ? (
                        <span className="font-medium text-slate-800">{task.assignee}</span>
                      ) : (
                        <span className="text-slate-400">не назначен</span>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {summary.decisions.length > 0 ? (
            <div>
              <h3 className="text-base font-semibold tracking-tight text-slate-950">Решения</h3>
              <ul data-testid="summary-decisions" className="mt-2 space-y-3">
                {summary.decisions.map((decision) => (
                  <li
                    key={decision.id}
                    data-testid="summary-decision"
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-800"
                  >
                    {decision.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {startError ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800"
        >
          {startError}
        </div>
      ) : null}
    </section>
  );
}
