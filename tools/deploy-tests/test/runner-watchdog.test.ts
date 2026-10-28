import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SUITES = ['test/e2e/a.test.ts', 'test/e2e/b.test.ts'];

/**
 * A stand-in for `run-tests.js`: it writes the results it is told to, and then either ends, or
 * waits on a child that calls itself Jest and never exits, as the runner waited on 2026-10-27.
 */
const RUNNER = `
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [nextDir, mode, ...written] = process.argv.slice(2);
for (const suite of written) {
  mkdirSync(path.dirname(path.join(nextDir, suite)), { recursive: true });
  writeFileSync(path.join(nextDir, suite + '.results.json'), '{}');
}
if (mode === 'hang') {
  const jest = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'jest', written.at(-1)], {
    stdio: 'ignore',
  });
  jest.on('exit', () => process.exit(3));
} else if (mode === 'slow') {
  setTimeout(() => process.exit(0), 1500);
} else {
  process.exit(0);
}
`;

describe('the runner, watched', () => {
  const dirs: string[] = [];
  const script = path.resolve(import.meta.dirname, '../src/runner-watchdog.ts');

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function watched(mode: string, written: readonly string[]) {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-runner-watchdog-'));
    dirs.push(base);
    const nextDir = path.join(base, 'nextjs');
    const results = path.join(base, 'deploy-results');
    mkdirSync(nextDir);
    mkdirSync(results);
    writeFileSync(path.join(results, 'expected-tests.txt'), `${SUITES.join('\n')}\n`);
    const runner = path.join(base, 'runner.mjs');
    writeFileSync(runner, RUNNER);
    const run = spawnSync(
      process.execPath,
      [
        script,
        '--next-dir',
        nextDir,
        '--results',
        results,
        '--quiet-ms',
        '300',
        '--poll-ms',
        '100',
        '--',
        process.execPath,
        runner,
        nextDir,
        mode,
        ...written,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    return { run, results };
  }

  it('ends a Jest process that wrote its result and did not exit, and says what it was doing', () => {
    const { run, results } = watched('hang', SUITES);
    const said = JSON.parse(readFileSync(path.join(results, 'watchdog.json'), 'utf8')) as {
      readonly ended: readonly string[];
    };

    // The runner's own code: the one it gave once the Jest process it waited on had gone.
    expect(run.status).toBe(3);
    expect(said.ended).toStrictEqual(['test/e2e/b.test.ts']);
    expect(run.stdout).toContain('every listed suite left its result');
    expect(run.stdout).toContain('--- what each Jest process is doing ---');
    expect(run.stdout).toMatch(/pid \d+: State:/u);
  });

  it('leaves a runner alone while a suite has left no result', () => {
    const { run, results } = watched('slow', SUITES.slice(0, 1));

    expect(run.status).toBe(0);
    expect(existsSync(path.join(results, 'watchdog.json'))).toBe(false);
  });

  it('gives the runner’s exit code back where it ends on its own', () => {
    const { run, results } = watched('done', SUITES);

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('runner-watchdog:');
    expect(existsSync(path.join(results, 'watchdog.json'))).toBe(false);
  });
});
