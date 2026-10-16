import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseMeasurement } from '../src/contract.ts';
import type { Run } from '../src/protocol.ts';
import { AT, SHA, success } from './helpers.ts';

const mocked = vi.hoisted(() => {
  return {
    measureRun: vi.fn<() => Promise<Run>>(),
    nowIso: vi.fn<() => string>(),
  };
});
vi.mock(import('../src/run.ts'), () => ({ measureRun: mocked.measureRun }));
vi.mock(import('../src/time.ts'), async (original) => {
  return {
    ...(await original()),
    nowIso: mocked.nowIso,
  };
});

describe('measurement artifact CLI', () => {
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  let directory: string;
  let output: string;

  beforeEach(() => {
    vi.resetModules();
    mocked.measureRun.mockReset().mockResolvedValue(success().run);
    mocked.nowIso.mockReset().mockReturnValue(AT);
    vi.spyOn(console, 'log').mockImplementation(() => {
      // Assertions read the artifact rather than the CLI's status line.
    });
    vi.stubEnv('GITHUB_REPOSITORY', 'arkorlab/upwind');
    vi.stubEnv('GITHUB_RUN_ID', '123');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
    vi.stubEnv('GITHUB_SHA', SHA);
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    directory = mkdtempSync(path.join(tmpdir(), 'upwind-benchmark-artifact-'));
    output = path.join(directory, 'attempt.json');
    process.argv = [process.execPath, 'main.ts', '--github', output];
  });

  afterEach(() => {
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['refs/heads/topic', 'refs/tags/v1.0.0'])(
    'writes an artifact for the selected manual ref %s',
    async (ref) => {
      vi.stubEnv('GITHUB_REF', ref);
      await import('../src/main.ts');
      const artifact = parseMeasurement(JSON.parse(readFileSync(output, 'utf8')) as unknown);

      expect(artifact.status).toBe('success');
      expect(artifact.source.ref).toBe(ref);
      expect(mocked.measureRun).toHaveBeenCalledWith('github');
    },
  );

  it('writes a failure artifact with raw evidence when the wall clock steps backwards', async () => {
    const earlier = '2026-10-15T23:59:59.000Z';
    const attempted = { ...success().run, finishedAt: earlier };
    mocked.measureRun.mockResolvedValue(attempted);
    mocked.nowIso.mockReturnValueOnce(AT).mockReturnValueOnce(earlier);
    await import('../src/main.ts');
    const artifact = parseMeasurement(JSON.parse(readFileSync(output, 'utf8')) as unknown);

    expect(artifact.status).toBe('failure');
    expect(artifact.startedAt).toBe(AT);
    expect(artifact.finishedAt).toBe(AT);
    expect(artifact.run).toStrictEqual(attempted);
    expect(process.exitCode).toBe(1);
  });
});
