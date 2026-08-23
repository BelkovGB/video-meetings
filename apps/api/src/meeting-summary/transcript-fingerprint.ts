import { createHash } from 'node:crypto';

/**
 * A stable identity for "this exact set of ready transcript files" attached
 * to a meeting — not their content: a transcript file is written once by the
 * worker and never edited in place, so its id already stands for its
 * content. Order-independent, so callers can pass ids in any order.
 */
export function computeTranscriptFingerprint(transcriptFileIds: readonly string[]): string {
  const sortedIds = [...transcriptFileIds].sort();

  return createHash('sha256').update(sortedIds.join(',')).digest('hex');
}
