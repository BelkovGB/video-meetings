import type { TranscriptionFailureCode, TranscriptionStatus } from '../../../lib/api/contracts';

export const transcriptionStatusLabels: Record<TranscriptionStatus, string> = {
  queued: 'В очереди на расшифровку',
  processing: 'Расшифровывается…',
  ready: 'Расшифровка готова',
  error: 'Ошибка расшифровки',
};

export const transcriptionFailureReasons: Record<TranscriptionFailureCode, string> = {
  AUDIO_PREPARATION_FAILED: 'Не удалось подготовить аудиодорожку',
  RECOGNITION_FAILED: 'Распознавание речи завершилось ошибкой',
  RECOGNITION_OUTPUT_INVALID: 'Модель вернула некорректный результат',
  NO_SPEECH_DETECTED: 'В записи не обнаружена речь',
  INSUFFICIENT_STORAGE: 'Не хватило места в хранилище',
  TRANSCRIPT_STORAGE_FAILED: 'Не удалось сохранить транскрипт',
  SOURCE_FILE_UNAVAILABLE: 'Исходная запись стала недоступна',
  INTERNAL_ERROR: 'Внутренняя ошибка сервиса',
};

/**
 * Both maps above are indexed with a string the server sent, so a plain
 * bracket lookup would resolve an unexpected value like `__proto__` or
 * `toString` to a function instead of `undefined` and crash the row's render.
 * `Object.hasOwn` keeps the lookup to the map's own labelled entries.
 */
export function transcriptionStatusLabel(status: TranscriptionStatus): string {
  return Object.hasOwn(transcriptionStatusLabels, status)
    ? transcriptionStatusLabels[status]
    : transcriptionStatusLabels.error;
}

export function transcriptionFailureReason(code: TranscriptionFailureCode): string {
  return Object.hasOwn(transcriptionFailureReasons, code)
    ? transcriptionFailureReasons[code]
    : transcriptionFailureReasons.INTERNAL_ERROR;
}
