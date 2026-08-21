import { spawn } from 'node:child_process';

const maxStdoutBytes = 64 * 1024 * 1024;
const maxStderrBytes = 8 * 1024;

export type ExternalProcessOptions = {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
};

export class ExternalProcessError extends Error {
  constructor(
    readonly executable: string,
    readonly reason: string,
    readonly stderr: string,
  ) {
    super(`${executable} ${reason}`);
    this.name = 'ExternalProcessError';
  }
}

/**
 * Runs an external program and returns its stdout.
 *
 * No shell: the executable and its arguments come from configuration as
 * separate values, so nothing has to guess how a Windows path with spaces was
 * meant to be split, and no file name a user chose can become an argument.
 */
export async function runExternalProcess(options: ExternalProcessOptions): Promise<string> {
  return new Promise<string>((settle, fail) => {
    const child = spawn(options.executable, [...options.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let overflowed = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    const finish = (error: ExternalProcessError | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        fail(error);
        return;
      }

      settle(Buffer.concat(stdoutChunks).toString('utf8'));
    };

    const stderrText = (): string => Buffer.concat(stderrChunks).toString('utf8').trim();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;

      if (stdoutBytes > maxStdoutBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }

      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxStderrBytes) {
        return;
      }

      stderrBytes += chunk.byteLength;
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      finish(new ExternalProcessError(options.executable, `failed to start: ${error.message}`, ''));
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(
          new ExternalProcessError(
            options.executable,
            `timed out after ${options.timeoutMs} ms`,
            stderrText(),
          ),
        );
        return;
      }

      if (overflowed) {
        finish(
          new ExternalProcessError(
            options.executable,
            `wrote more than ${maxStdoutBytes} bytes to stdout`,
            stderrText(),
          ),
        );
        return;
      }

      if (code !== 0) {
        finish(
          new ExternalProcessError(
            options.executable,
            `exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
            stderrText(),
          ),
        );
        return;
      }

      finish(undefined);
    });
  });
}
