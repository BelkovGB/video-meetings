'use strict';

// Stands in for the recognition command in e2e runs: same contract, no GPU, no
// model and no download.
//
// Arguments are the control file (test/setup.ts puts it first) and the prepared
// audio path the worker appends last. The control file is JSON and may hold:
//   segments             array of { start, end, text } to print
//   stdout               raw stdout, for malformed-output cases
//   stdoutBase64         exact stdout bytes, for output that is not UTF-8
//   recognizerExitCode   non-zero to fail the job
//   holdMs               how long to stay running, so a spec can act on a job
//                        in flight
//   tracePath            file to append `start` and `end` to around that hold:
//                        overlapping runs interleave the lines, runs taken one
//                        at a time do not
//
// A control file rather than environment variables: jest hands a test its own
// copy of the environment and a spawned child inherits the real one, so nothing
// a spec sets there would arrive here.

const { appendFileSync, readFileSync } = require('node:fs');

const controlPath = process.argv[2];
const audioPath = process.argv[3];

if (!audioPath) {
  process.stderr.write('missing audio path\n');
  process.exit(2);
}

let control = {};
try {
  control = JSON.parse(readFileSync(controlPath, 'utf8'));
} catch {
  // No control file: the defaults below stand for a recording that recognizes.
}

if (control.tracePath) {
  appendFileSync(control.tracePath, 'start\n');
}

if (control.holdMs > 0) {
  // Blocking on purpose: the recognition this stands in for holds the GPU for
  // minutes, and a spec proving two jobs never overlap needs this run to still
  // be running while the next job could be claimed.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, control.holdMs);
}

if (control.tracePath) {
  appendFileSync(control.tracePath, 'end\n');
}

if (control.recognizerExitCode) {
  process.stderr.write('fake recognizer failure\n');
  process.exit(control.recognizerExitCode);
}

if (control.stdoutBase64 !== undefined) {
  process.stdout.write(Buffer.from(control.stdoutBase64, 'base64'));
  process.exit(0);
}

if (control.stdout !== undefined) {
  process.stdout.write(control.stdout);
  process.exit(0);
}

const segments = control.segments ?? [
  { start: 0, end: 1.5, text: 'first utterance' },
  { start: 1.5, end: 3, text: 'second utterance' },
];

process.stdout.write(JSON.stringify({ segments }));
