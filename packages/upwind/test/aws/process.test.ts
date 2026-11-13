import { describe, expect, it } from 'vitest';

import { runCommand } from '../../src/aws/process.ts';

describe('bounded AWS build commands', () => {
  it.skipIf(process.platform === 'win32')(
    'stops inherited-stdio descendants that ignore graceful termination',
    async () => {
      const descendant = [
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
        // Bound the fixture itself if a regression leaves the descendant running.
        'setTimeout(() => process.exit(0), 4000);',
      ].join('\n');
      const script = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });`,
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const started = performance.now();
      await expect(
        runCommand(process.execPath, ['-e', script], { timeoutMs: 500 }),
      ).rejects.toThrow('timed out');
      expect(performance.now() - started).toBeLessThan(3000);
    },
  );

  it('waits for a stalled child to stop before rejecting the timeout', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }),
    ).rejects.toThrow('timed out');
  });

  it('cancels a running command and refuses to spawn an already cancelled command', async () => {
    const controller = new AbortController();
    const running = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow('cancelled');
    await expect(
      runCommand(process.execPath, ['-e', 'throw Error("should not run")'], {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('bounds both stdout and captured quiet stderr', async () => {
    for (const stream of ['stdout', 'stderr']) {
      await expect(
        runCommand(process.execPath, ['-e', `process.${stream}.write('x'.repeat(4096))`], {
          quiet: true,
          maxOutputBytes: 1024,
        }),
      ).rejects.toThrow('output limit');
    }
    await expect(runCommand(process.execPath, ['-e', "console.log('complete')"])).resolves.toBe(
      'complete',
    );
  });
});
