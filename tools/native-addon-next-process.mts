/** Bounded process groups used only by the isolated Linux native-addon CI control. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';

const MAX_BUILD_MS = 900_000;
const CLOSE_MS = 35_000;
const KILL_MS = 5_000;
const POLL_MS = 100;
const MAX_OUTPUT = 2_097_152;

function missingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!missingProcess(error)) throw error;
  }
}

function alive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (missingProcess(error)) return false;
    throw error;
  }
}

export function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  signalGroup(child, 'SIGTERM');
  const deadline = performance.now() + CLOSE_MS;
  while (alive(child) && performance.now() < deadline) await pause(POLL_MS);
  if (alive(child)) signalGroup(child, 'SIGKILL');
  const hardDeadline = performance.now() + KILL_MS;
  while (alive(child) && performance.now() < hardDeadline) await pause(POLL_MS);
  assert(!alive(child), 'A CI child process group survived cleanup');
}

export class NativeNextProcesses {
  readonly #children = new Set<ChildProcess>();
  #interrupted = false;

  get interrupted(): boolean {
    return this.#interrupted;
  }

  interrupt(): void {
    this.#interrupted = true;
    process.exitCode = 1;
    for (const child of this.#children) signalGroup(child, 'SIGKILL');
  }

  async command(
    args: readonly string[],
    cwd: string,
    options: { readonly env: NodeJS.ProcessEnv; readonly capture?: boolean },
  ): Promise<string> {
    assert(!this.#interrupted, 'The CI control was interrupted');
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- The isolated CI toolchain provisions pnpm; its exact version is verified before installing this fixed fixture.
    const child = spawn('pnpm', args, {
      cwd,
      env: options.env,
      detached: true,
      stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    this.#children.add(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT) signalGroup(child, 'SIGKILL');
    });
    const deadline = setTimeout(() => {
      signalGroup(child, 'SIGKILL');
    }, MAX_BUILD_MS);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode) => {
          resolve(exitCode);
        });
      });
      assert.equal(code, 0, 'The isolated native fixture command failed');
      return output;
    } finally {
      clearTimeout(deadline);
      await this.stop(child);
    }
  }

  start(entry: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
    assert(!this.#interrupted, 'The CI control was interrupted');
    const child = spawn(process.execPath, [entry], {
      cwd,
      env,
      detached: true,
      stdio: 'inherit',
    });
    this.#children.add(child);
    return child;
  }

  async stop(child: ChildProcess): Promise<void> {
    await stop(child);
    this.#children.delete(child);
  }

  async cleanup(): Promise<boolean> {
    const closed = await Promise.allSettled(Array.from(this.#children, (child) => stop(child)));
    return closed.every((result) => result.status === 'fulfilled');
  }
}
