import { spawn } from 'node:child_process';

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Uint8Array;
  readonly quiet?: boolean;
}

/** Run an argument vector without a shell; stdin keeps registry passwords out of argv. */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', options.quiet ? 'pipe' : 'inherit'],
      shell: false,
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (bytes: Buffer) => {
      output.push(bytes);
    });
    child.stderr?.on('data', (bytes: Buffer) => {
      errors.push(bytes);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
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
    child.stdin.on('error', () => {
      // A process that exits before reading stdin is reported by its close/error event.
    });
    child.stdin.end(options.input);
  });
}
