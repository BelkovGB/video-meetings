import type { MeetingSummaryFailureCode, MeetingSummaryStatus } from '../../../lib/api/contracts';

export const summaryStatusLabels: Record<MeetingSummaryStatus, string> = {
  queued: 'В очереди на выжимку',
  processing: 'Готовим выжимку…',
  ready: 'Выжимка готова',
  error: 'Ошибка выжимки',
};

export const summaryFailureReasons: Record<MeetingSummaryFailureCode, string> = {
  INPUT_TOO_LARGE: 'Транскрипт слишком большой для обработки',
  MODEL_OUTPUT_INVALID: 'Модель вернула некорректный результат',
  TIME_LIMIT_EXCEEDED: 'Превышено время обработки',
  INTERRUPTED: 'Обработка была прервана',
  INTERNAL_ERROR: 'Внутренняя ошибка сервиса',
};

/**
 * Both maps above are indexed with a string the server sent, so a plain
 * bracket lookup would resolve an unexpected value like `__proto__` or
 * `toString` to a function instead of `undefined` and crash the panel's
 * render. `Object.hasOwn` keeps the lookup to the map's own labelled entries.
 */
export function summaryStatusLabel(status: MeetingSummaryStatus): string {
  return Object.hasOwn(summaryStatusLabels, status)
    ? summaryStatusLabels[status]
    : summaryStatusLabels.error;
}

export function summaryFailureReason(code: MeetingSummaryFailureCode): string {
  return Object.hasOwn(summaryFailureReasons, code)
    ? summaryFailureReasons[code]
    : summaryFailureReasons.INTERNAL_ERROR;
}
