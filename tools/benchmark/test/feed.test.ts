import { describe, expect, it } from 'vitest';

import { type Index, parseIndex, parseMeasurement } from '../src/contract.ts';
import { appendAttempt } from '../src/feed.ts';
import { finalizeAttempt } from '../src/finalize.ts';
import { AT, completed, failure, success } from './helpers.ts';

describe('public benchmark feed', () => {
  it('numbers publications, keeps reruns separate, and makes delivery idempotent', () => {
    const first = appendAttempt(undefined, success(), AT);

    expect(appendAttempt(first, failure(), AT)).toBe(first);

    const second = appendAttempt(first, { ...failure(), runAttempt: 2 }, AT);

    expect(second.sequence).toBe(2);
    expect(second.attempts.map((attempt) => [attempt.sequence, attempt.runAttempt])).toStrictEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(parseIndex(second)).toStrictEqual(second);
  });

  it('retains failures since the oldest of 120 retained successes', () => {
    let index: Index | undefined;
    for (let run = 1; run <= 121; run += 1) {
      index = appendAttempt(index, success(String(run * 2)), AT);
      index = appendAttempt(index, failure(String(run * 2 + 1)), AT);
    }

    expect(index?.sequence).toBe(242);
    expect(index?.attempts.filter((attempt) => attempt.status === 'success')).toHaveLength(120);
    expect(index?.attempts.filter((attempt) => attempt.status === 'failure')).toHaveLength(120);
    expect(index?.attempts[0]?.sequence).toBe(3);
  });

  it('bounds failures before any success and never resets its sequence', () => {
    let index: Index | undefined;
    for (let run = 1; run <= 3001; run += 1) {
      index = appendAttempt(index, failure(String(run)), AT);
    }

    expect(index?.sequence).toBe(3001);
    expect(index?.attempts).toHaveLength(3000);
    expect(index?.attempts[0]?.sequence).toBe(2);
    expect(parseIndex(index).sequence).toBe(3001);
  });

  it('refuses corrupted sequences, duplicate identities and foreign result paths', () => {
    const index = appendAttempt(undefined, success(), AT);

    expect(() => parseIndex({ ...index, sequence: 0 })).toThrow('expected a bounded integer');
    expect(() =>
      parseIndex({ ...index, attempts: [...index.attempts, ...index.attempts] }),
    ).toThrow('expected a bounded integer');
    expect(() => {
      parseIndex({ ...index, attempts: [{ ...index.attempts[0], result: '../other.json' }] });
    }).toThrow('invalid immutable result path');
  });

  it('validates sample milestones and fixed settings before accepting an artifact', () => {
    const measurement = success();

    expect(parseMeasurement(measurement)).toStrictEqual(measurement);
    expect(() => parseMeasurement({ ...measurement, protocol: 999 })).toThrow(
      'unexpected benchmark protocol or targets',
    );
    expect(() => {
      parseMeasurement({
        ...measurement,
        run: { ...measurement.run, settings: { ...measurement.run.settings, warmup: 2 } },
      });
    }).toThrow('unexpected measurement configuration');

    const invalid = {
      ...measurement,
      run: {
        ...measurement.run,
        scenarios: measurement.run.scenarios.map((scenario) => {
          return {
            ...scenario,
            pairs: scenario.pairs.map((pair) => {
              return {
                ...pair,
                vercel: { ...pair.vercel, firstByteMs: 0 },
              };
            }),
          };
        }),
      },
    };

    expect(() => parseMeasurement(invalid)).toThrow('invalid timing milestones');
  });

  it('keeps prior protocol and target epochs structurally readable', () => {
    const index = appendAttempt(undefined, success(), AT);
    const historical = {
      ...index,
      attempts: index.attempts.map((attempt) => {
        return {
          ...attempt,
          protocol: 1,
          targets: { vercel: 'https://old-vercel.example/', arkor: 'https://old-arkor.example/' },
        };
      }),
    };

    expect(parseIndex(historical)).toStrictEqual(historical);
  });

  it('keeps failed raw samples in the artifact without copying them into the index', () => {
    const measurement = failure();

    expect(parseMeasurement(measurement)).toStrictEqual(measurement);
    expect(measurement).toHaveProperty('run');

    const index = appendAttempt(undefined, measurement, AT);

    expect(index.attempts[0]).not.toHaveProperty('run');
  });
});

describe('trusted completion finalizer', () => {
  it.each([
    '.github/workflows/benchmark.yaml',
    '.github/workflows/benchmark.yaml@main',
    '.github/workflows/benchmark.yaml@refs/heads/main',
  ])('accepts the documented workflow path form %s', (workflowPath) => {
    expect(finalizeAttempt(completed({ path: workflowPath }), success())).toStrictEqual(success());
  });

  it.each(['cancelled', 'timed_out', 'failure', 'success'])(
    'records %s with no artifact as a failed scheduled attempt',
    (conclusion) => {
      const result = finalizeAttempt(completed({ conclusion }), undefined);

      expect(result?.status).toBe('failure');
      expect(result?.source.runner.node).toBe('unavailable');
      expect(result).toMatchObject({ runId: '123', runAttempt: 1 });
    },
  );

  it('accepts valid data and records invalid or missing data as a failure', () => {
    expect(finalizeAttempt(completed(), success())).toStrictEqual(success());
    expect(finalizeAttempt(completed(), null)?.status).toBe('failure');
    expect(finalizeAttempt(completed(), success('456'))?.status).toBe('failure');
  });

  it.each([
    { event: 'workflow_dispatch' },
    { event: 'pull_request' },
    { head_branch: 'another' },
    { path: '.github/workflows/ci.yaml' },
    { path: '.github/workflows/benchmark.yaml@another' },
    { head_repository: { full_name: 'someone/upwind' } },
  ])('publishes no canonical observation for %j', (overrides) => {
    expect(finalizeAttempt(completed(overrides), success())).toBeNull();
  });
});
