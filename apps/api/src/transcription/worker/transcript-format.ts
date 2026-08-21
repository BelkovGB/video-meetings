import { TranscriptSegment } from '../models/transcript-segment';

function formatTimecode(seconds: number): string {
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];

  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

/**
 * One line per utterance, opening with its `[HH:MM:SS - HH:MM:SS]` range.
 *
 * Phase 2 puts the speaker label after the range.
 */
export function formatTranscript(segments: readonly TranscriptSegment[]): string {
  return segments
    .map(
      (segment) =>
        `[${formatTimecode(segment.startSeconds)} - ${formatTimecode(segment.endSeconds)}] ` +
        `${segment.text}\n`,
    )
    .join('');
}
