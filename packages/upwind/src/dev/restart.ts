import { writeSync } from 'node:fs';

/**
 * Next.js's own devtools restart uses exit 77 after invalidating its caches and flushing telemetry
 * (`next-devtools/server/restart-dev-server-middleware.ts`). The supervisor recognizes the same code.
 */
export const RESTART_EXIT_CODE = 77;
export const NEXT_RESTART_SYMBOL = 'upwind.next-devtools-restart';
const CLEANUP_DEADLINE_MS = 1500;
const nativeExit: typeof process.exit = process.exit.bind(process);
const state: { cleanup?: () => Promise<void>; exiting: boolean } = { exiting: false };

/** The dev server installs cleanup before watching files or opening remote connections. */
export function beforeRestart(dispose: () => Promise<void>): void {
  state.cleanup = dispose;
  Reflect.set(globalThis, Symbol.for(NEXT_RESTART_SYMBOL), () => {
    restart('Next.js requested a restart');
  });
}

function writeWarning(): void {
  try {
    writeSync(2, 'upwind: could not finish resource cleanup before exiting\n');
  } catch {
    // Losing a diagnostic must not prevent the exit.
  }
}

function finish(code: number, reason?: string): void {
  if (state.exiting) return;
  state.exiting = true;
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        state.cleanup?.(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('resource cleanup timed out'));
          }, CLEANUP_DEADLINE_MS);
        }),
      ]);
    } catch {
      writeWarning();
    } finally {
      clearTimeout(timer);
    }
    leave(code, reason);
  })().catch(() => {
    leave(code, reason);
  });
}

/** Say why, drain this run's resources, then leave with the supervisor's restart code. */
export function restart(reason: string): void {
  finish(RESTART_EXIT_CODE, reason);
}

/** An interrupt during startup still owns any pending local/remote resource setup. */
export function stopDuringStartup(): void {
  finish(0);
}

function leave(code: number, reason?: string): never {
  if (reason !== undefined) {
    // A synchronous descriptor write survives exiting a process whose console output is piped.
    try {
      writeSync(1, `upwind: ${reason}; restarting...\n`);
    } catch {
      // Losing a diagnostic must not prevent the restart.
    }
  }
  nativeExit(code);
}
