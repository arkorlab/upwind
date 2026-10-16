import {
  type AttemptBase,
  type Measurement,
  parseMeasurement,
  REPOSITORY,
  SCHEMA_VERSION,
  WORKFLOW,
} from './contract.ts';
import { boundedText, PROTOCOL, TARGETS } from './protocol.ts';
import { normalizeIso } from './time.ts';

const WORKFLOW_PATHS = new Set([`${WORKFLOW}@main`, `${WORKFLOW}@refs/heads/main`, WORKFLOW]);

interface CompletedEvent {
  readonly repository: { readonly full_name: string };
  readonly workflow_run: {
    readonly id: number;
    readonly run_attempt: number;
    readonly path: string;
    readonly event: string;
    readonly head_branch: string;
    readonly head_repository: { readonly full_name: string };
    readonly head_sha: string;
    readonly html_url: string;
    readonly run_started_at: string;
    readonly updated_at: string;
    readonly conclusion: string;
  };
}

/** The event is from GitHub; the artifact is untrusted JSON and is never executed. */
export function finalizeAttempt(event: unknown, artifact: unknown): Measurement | null {
  const completed = event as CompletedEvent;
  const run = completed.workflow_run;
  if (
    completed.repository.full_name !== REPOSITORY ||
    run.head_repository.full_name !== REPOSITORY ||
    !WORKFLOW_PATHS.has(run.path) ||
    run.event !== 'schedule' ||
    run.head_branch !== 'main'
  ) {
    return null;
  }
  const expected: AttemptBase = {
    runId: String(run.id),
    runAttempt: run.run_attempt,
    startedAt: normalizeIso(run.run_started_at),
    finishedAt: normalizeIso(run.updated_at),
    protocol: PROTOCOL,
    targets: TARGETS,
    source: {
      repository: REPOSITORY,
      workflow: WORKFLOW,
      ref: 'refs/heads/main',
      sha: run.head_sha,
      runUrl: run.html_url,
      // An attempt cancelled before the upload has no observed runner image or Node version.
      runner: {
        os: 'Linux',
        arch: 'X64',
        imageOS: 'ubuntu24',
        imageVersion: 'unavailable',
        node: 'unavailable',
      },
    },
  };
  let error = `workflow ${run.conclusion}; measurement artifact unavailable`;
  if (artifact !== undefined) {
    try {
      const read = parseMeasurement(artifact);
      if (
        read.runId !== expected.runId ||
        read.runAttempt !== expected.runAttempt ||
        read.source.sha !== expected.source.sha ||
        read.source.runUrl !== expected.source.runUrl
      ) {
        throw new Error('artifact belongs to another workflow attempt');
      }
      if (read.status === 'failure' || run.conclusion === 'success') {
        return read;
      }
      return {
        ...read,
        status: 'failure',
        error: boundedText(`workflow ${run.conclusion} after measurement`),
      };
    } catch {
      error = `workflow ${run.conclusion}; measurement artifact invalid`;
    }
  }
  return parseMeasurement({
    ...expected,
    schemaVersion: SCHEMA_VERSION,
    status: 'failure',
    error: boundedText(error),
  });
}
