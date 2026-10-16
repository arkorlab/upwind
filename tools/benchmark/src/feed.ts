import {
  FAILURE_LIMIT,
  type AttemptBase,
  type Index,
  type Measurement,
  type PublishedAttempt,
  resultPath,
  SCHEMA_VERSION,
  SUCCESS_LIMIT,
} from './contract.ts';

/**
 * One publication per workflow attempt, ordered by publication rather than the runner's clock.
 * Replaying the finalizer cannot replace an immutable attempt or consume another sequence number.
 */
export function appendAttempt(
  previous: Index | undefined,
  measurement: Measurement,
  publishedAt: string,
): Index {
  if (
    previous?.attempts.some(
      (attempt) =>
        attempt.runId === measurement.runId && attempt.runAttempt === measurement.runAttempt,
    ) === true
  ) {
    return previous;
  }
  const sequence = (previous?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) {
    throw new TypeError('publication sequence exhausted');
  }
  const base: AttemptBase = {
    runId: measurement.runId,
    runAttempt: measurement.runAttempt,
    startedAt: measurement.startedAt,
    finishedAt: measurement.finishedAt,
    source: measurement.source,
    protocol: measurement.protocol,
    targets: measurement.targets,
  };
  let next: PublishedAttempt;
  if (measurement.status === 'success') {
    next = { ...base, status: 'success', sequence, result: resultPath(measurement) };
  } else {
    next = { ...base, status: 'failure', sequence, error: measurement.error };
  }
  const attempts = [...(previous?.attempts ?? []), next];
  const successes = attempts
    .filter((attempt) => attempt.status === 'success')
    .slice(-SUCCESS_LIMIT);
  const since = successes[0]?.sequence ?? 0;
  const failures = attempts
    .filter((attempt) => attempt.status === 'failure' && attempt.sequence >= since)
    .slice(-FAILURE_LIMIT);
  const retained = new Set<PublishedAttempt>(successes);
  for (const failure of failures) {
    retained.add(failure);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sequence,
    publishedAt,
    attempts: attempts.filter((attempt) => retained.has(attempt)),
  };
}
