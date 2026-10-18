import {
  type Measurement,
  REPOSITORY,
  SCHEMA_VERSION,
  type Source,
  WORKFLOW,
} from '../src/contract.ts';
import { PROTOCOL, type Run, TARGETS } from '../src/protocol.ts';

export const AT = '2026-10-16T00:00:00.000Z';
export const SHA = 'a'.repeat(40);
export const SOURCE: Source = {
  repository: REPOSITORY,
  workflow: WORKFLOW,
  ref: 'refs/heads/main',
  sha: SHA,
  runUrl: 'https://github.com/arkorlab/upwind/actions/runs/123',
  runner: {
    os: 'Linux',
    arch: 'X64',
    imageOS: 'ubuntu24',
    imageVersion: '20261012.1',
    node: 'v24.22.0',
  },
};

export const SAMPLE = {
  status: 200,
  headersMs: 10,
  firstByteMs: 11,
  completeMs: 12,
  bytes: 2,
  markers: {},
  connection: { dnsMs: null, connectMs: null, tlsMs: null, reused: false },
};

export function success(runId = '123'): Extract<Measurement, { readonly status: 'success' }> {
  const run: Run = {
    protocol: PROTOCOL,
    vantage: 'github',
    location: null,
    startedAt: AT,
    finishedAt: AT,
    targets: TARGETS,
    settings: { pairs: 30, warmup: 20, spacingMs: 25, timeoutMs: 4000, budgetMs: 16_000 },
    scenarios: ['new-connection', 'reused-connection'].map((scenario) => {
      return {
        scenario: scenario as 'new-connection' | 'reused-connection',
        truncated: true,
        pairs: [{ first: 'vercel', vercel: SAMPLE, arkor: SAMPLE }],
      };
    }),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    runAttempt: 1,
    startedAt: AT,
    finishedAt: AT,
    source: { ...SOURCE, runUrl: `https://github.com/arkorlab/upwind/actions/runs/${runId}` },
    protocol: PROTOCOL,
    targets: TARGETS,
    status: 'success',
    run,
  };
}

export function failure(runId = '123'): Measurement {
  return { ...success(runId), status: 'failure', error: 'network unavailable' };
}

export function completed(overrides: Record<string, unknown> = {}): unknown {
  return {
    repository: { full_name: REPOSITORY },
    workflow_run: {
      id: 123,
      run_attempt: 1,
      path: WORKFLOW,
      event: 'schedule',
      head_branch: 'main',
      head_repository: { full_name: REPOSITORY },
      head_sha: SHA,
      html_url: SOURCE.runUrl,
      run_started_at: AT,
      updated_at: AT,
      conclusion: 'success',
      ...overrides,
    },
  };
}
