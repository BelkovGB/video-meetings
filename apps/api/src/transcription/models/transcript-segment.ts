/**
 * One recognized utterance, in seconds from the start of the recording.
 *
 * The recognition command produces these and the transcript formatter consumes
 * them, so the shape lives beside neither of them.
 */
export type TranscriptSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};
