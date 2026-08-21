import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The file the transcription fixture programs read their behaviour from.
 *
 * A spec cannot shape a spawned child through `process.env`: jest hands the
 * test its own copy of the environment, while `child_process` inherits the real
 * one, so a variable a test sets never reaches the child. The path is passed to
 * both fixtures as their first argument (see test/setup.ts), which keeps it
 * defined once, here, instead of once per fixture.
 */
export const fixtureControlPath = join(tmpdir(), 'video-meetings-api-e2e-fixtures.json');

export type TranscriptionFixtureControl = {
  /** Segments the recognizer prints. Defaults to two short utterances. */
  segments?: { start: number; end: number; text: string }[];
  /** Raw recognizer stdout, for malformed-output cases. */
  stdout?: string;
  /** Non-zero fails recognition. */
  recognizerExitCode?: number;
  /** Non-zero fails the conversion. */
  ffmpegExitCode?: number;
  /** How long the recognizer stays running, so a spec can act on a job in
   * flight or prove that two of them never overlap. */
  holdMs?: number;
  /** File the recognizer appends `start` and `end` to around that hold. */
  tracePath?: string;
};

export async function setTranscriptionFixtures(
  control: TranscriptionFixtureControl,
): Promise<void> {
  await writeFile(fixtureControlPath, JSON.stringify(control), 'utf8');
}

/** Returns the fixtures to their defaults. A control file outliving the test
 * that wrote it would shape every later run in the same jest process. */
export async function clearTranscriptionFixtures(): Promise<void> {
  await rm(fixtureControlPath, { force: true });
}
