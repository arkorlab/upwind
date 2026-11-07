import { spawn } from 'node:child_process';

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Uint8Array;
  readonly quiet?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

/** Run an argument vector without a shell; stdin keeps registry passwords out of argv. */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 1_800_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0
  )
    throw new Error('command time and output limits must be positive whole numbers');
  return new Promise((resolve, reject) => {
    const ownsGroup = process.platform !== 'win32';
    const child = spawn(command, [...args], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', options.quiet ? 'pipe' : 'inherit'],
      shell: false,
      // A package-manager/build child can spawn workers that retain its captured pipes.
      detached: ownsGroup,
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let captured = 0;
    let failure: Error | undefined;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      try {
        if (ownsGroup && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // It may have exited already. Cleanup never replaces the original command failure.
      }
    };
    const forceStop = (): void => {
      terminate('SIGKILL');
      // Escaped descendants (or Windows children) cannot retain the caller's captured I/O.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr?.destroy();
    };
    const stop = (error: Error): void => {
      if (failure !== undefined) return;
      failure = error;
      terminate('SIGTERM');
      forced = setTimeout(forceStop, 1000);
      forced.unref();
    };
    const cancelled = (): void => {
      stop(new Error(`${command} was cancelled`));
    };
    const timer = setTimeout(() => {
      stop(new Error(`${command} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    options.signal?.addEventListener('abort', cancelled, { once: true });
    const collect = (chunks: Buffer[], bytes: Buffer): void => {
      if (failure !== undefined) return;
      captured += bytes.byteLength;
      if (captured > maxOutputBytes) {
        stop(new Error(`${command} exceeded its captured output limit`));
        return;
      }
      chunks.push(bytes);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      if (forced !== undefined) clearTimeout(forced);
      options.signal?.removeEventListener('abort', cancelled);
    };
    child.stdout.on('data', (bytes: Buffer) => {
      collect(output, bytes);
    });
    child.stderr?.on('data', (bytes: Buffer) => {
      collect(errors, bytes);
    });
    child.once('error', (error) => {
      cleanup();
      reject(failure ?? error);
    });
    child.once('close', (code, signal) => {
      if (failure !== undefined) forceStop();
      cleanup();
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        const detail = options.quiet ? Buffer.concat(errors).toString('utf8').trim() : '';
        reject(
          new Error(
            `${command} failed (${signal ?? String(code)})${detail === '' ? '' : `: ${detail}`}`,
          ),
        );
      } else {
        resolve(Buffer.concat(output).toString('utf8').trim());
      }
    });
    if (options.signal?.aborted === true) cancelled();
    child.stdin.on('error', () => {
      // A process that exits before reading stdin is reported by its close/error event.
    });
    child.stdin.end(options.input);
  });
}
