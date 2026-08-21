import type { TranscriptionStatus } from '../../../lib/api/contracts';

export const transcriptionStatusLabels: Record<TranscriptionStatus, string> = {
  queued: 'В очереди на расшифровку',
  processing: 'Расшифровывается…',
  ready: 'Расшифровка готова',
  error: 'Ошибка расшифровки',
};
