'use strict';

// Stands in for ffmpeg in e2e runs. Its arguments are the control file
// (test/setup.ts puts it first), the worker's conversion arguments, and the
// output path last, where this writes an empty 16 kHz mono wav: the e2e
// recordings are a few header bytes no real ffmpeg would decode.
//
// The control file is JSON; `ffmpegExitCode` fails the conversion. See
// test/support/transcription-fixtures.ts for why a file and not an environment
// variable.

const { readFileSync, writeFileSync } = require('node:fs');

const controlPath = process.argv[2];
const outputPath = process.argv[process.argv.length - 1];

let control = {};
try {
  control = JSON.parse(readFileSync(controlPath, 'utf8'));
} catch {
  // No control file: the conversion succeeds.
}

if (control.ffmpegExitCode) {
  process.stderr.write('fake ffmpeg failure\n');
  process.exit(control.ffmpegExitCode);
}

const header = Buffer.alloc(44);

header.write('RIFF', 0, 'ascii');
header.writeUInt32LE(36, 4);
header.write('WAVE', 8, 'ascii');
header.write('fmt ', 12, 'ascii');
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36, 'ascii');
header.writeUInt32LE(0, 40);

writeFileSync(outputPath, header);
