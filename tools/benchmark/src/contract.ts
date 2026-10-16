import { boundedText, type Pair, PROTOCOL, type Run, SETTINGS, TARGETS } from './protocol.ts';
import { parseIso } from './time.ts';

export const SCHEMA_VERSION = 1;
export const REPOSITORY = 'arkorlab/upwind';
export const WORKFLOW = '.github/workflows/benchmark.yaml';
export const SUCCESS_LIMIT = 120;
export const FAILURE_LIMIT = 3000;
const MAX_TEXT = 200;
const MAX_MILLISECONDS = 600_000;
const MAX_STATUS = 599;

export interface Source {
  readonly repository: typeof REPOSITORY;
  readonly workflow: typeof WORKFLOW;
  readonly ref: string;
  readonly sha: string;
  readonly runUrl: string;
  readonly runner: {
    readonly os: string;
    readonly arch: string;
    readonly imageOS: string;
    readonly imageVersion: string;
    readonly node: string;
  };
}

export interface Identity {
  readonly runId: string;
  readonly runAttempt: number;
}

export interface AttemptBase extends Identity {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly source: Source;
  readonly protocol: number;
  readonly targets: typeof TARGETS;
}

export type Measurement = AttemptBase &
  (
    | { readonly schemaVersion: 1; readonly status: 'success'; readonly run: Run }
    | {
        readonly schemaVersion: 1;
        readonly status: 'failure';
        readonly error: string;
        /** Available attempted samples remain in the downloadable artifact, outside the index. */
        readonly run?: Run;
      }
  );

export type PublishedAttempt = AttemptBase & { readonly sequence: number } & (
    | { readonly status: 'success'; readonly result: string }
    | { readonly status: 'failure'; readonly error: string }
  );

export interface Index {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly publishedAt: string;
  /** Ascending publication sequence, including failed and cancelled scheduled attempts. */
  readonly attempts: readonly PublishedAttempt[];
}

export interface Result extends Identity {
  readonly schemaVersion: 1;
  readonly run: Run;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw new Error('expected bounded nonempty text');
  }
  return value;
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error('expected a bounded integer');
  }
  return value;
}

function iso(value: unknown): string {
  const read = text(value);
  return parseIso(read);
}

function interval(value: Record<string, unknown>, ordered = true): void {
  const startedAt = iso(value['startedAt']);
  const finishedAt = iso(value['finishedAt']);
  if (ordered && finishedAt < startedAt) {
    throw new Error('measurement finished before it started');
  }
}

function identity(value: Record<string, unknown>): void {
  if (!/^\d+$/u.test(text(value['runId']))) {
    throw new Error('invalid workflow run id');
  }
  integer(value['runAttempt'], 1);
}

function sourceOf(value: unknown, runId: string): Source {
  const read = object(value);
  if (
    read['repository'] !== REPOSITORY ||
    read['workflow'] !== WORKFLOW ||
    !/^refs\/(?:heads|tags)\/.+$/u.test(text(read['ref'])) ||
    read['runUrl'] !== `https://github.com/${REPOSITORY}/actions/runs/${runId}` ||
    !/^[a-f\d]{40}$/u.test(text(read['sha']))
  ) {
    throw new Error('invalid workflow provenance');
  }
  const runner = object(read['runner']);
  for (const name of ['os', 'arch', 'imageOS', 'imageVersion', 'node']) {
    text(runner[name]);
  }
  return read as unknown as Source;
}

function base(value: Record<string, unknown>): void {
  identity(value);
  interval(value);
  sourceOf(value['source'], String(value['runId']));
  integer(value['protocol'], 1);
  const targets = object(value['targets']);
  for (const side of ['vercel', 'arkor']) {
    if (new URL(text(targets[side])).protocol !== 'https:') {
      throw new Error('expected an HTTPS measurement target');
    }
  }
}

function sample(value: unknown): void {
  const read = object(value);
  integer(read['status'], 0, MAX_STATUS);
  if (read['error'] !== undefined) {
    text(read['error']);
  }
  let last = 0;
  let stopped = false;
  for (const name of ['headersMs', 'firstByteMs', 'completeMs']) {
    const ms = read[name];
    if (ms === null) {
      stopped = true;
    } else if (
      stopped ||
      typeof ms !== 'number' ||
      !Number.isFinite(ms) ||
      ms < last ||
      ms > MAX_MILLISECONDS
    ) {
      throw new Error('invalid timing milestones');
    } else {
      last = ms;
    }
  }
  if (read['bytes'] !== null) {
    integer(read['bytes'], 0);
  }
  const markers = Object.values(object(read['markers']));
  for (const marker of markers) {
    text(marker);
  }
  const connection = object(read['connection']);
  if (typeof connection['reused'] !== 'boolean') {
    throw new TypeError('missing actual connection reuse');
  }
  for (const name of ['dnsMs', 'connectMs', 'tlsMs']) {
    const ms = connection[name];
    if (
      ms !== null &&
      (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_MILLISECONDS)
    ) {
      throw new Error('invalid connection timing');
    }
  }
}

function scenarioOf(value: unknown, index: number): void {
  const part = object(value);
  if (
    part['scenario'] !== (index === 0 ? 'new-connection' : 'reused-connection') ||
    typeof part['truncated'] !== 'boolean' ||
    !Array.isArray(part['pairs']) ||
    part['pairs'].length > SETTINGS.pairs
  ) {
    throw new Error('invalid measurement scenario');
  }
  const pairs = part['pairs'];
  if (!part['truncated'] && pairs.length !== SETTINGS.pairs) {
    throw new Error('complete scenario must contain all planned pairs');
  }
  for (const [pairIndex, pair] of pairs.entries()) {
    const paired = object(pair);
    if (paired['first'] !== (pairIndex % 2 === 0 ? 'vercel' : 'arkor')) {
      throw new Error('invalid alternating pair order');
    }
    sample(paired['vercel']);
    sample(paired['arkor']);
  }
}

function runOf(value: unknown, ordered = true): Run {
  const read = object(value);
  if (
    read['protocol'] !== PROTOCOL ||
    read['vantage'] !== 'github' ||
    read['location'] !== null ||
    JSON.stringify(read['targets']) !== JSON.stringify(TARGETS) ||
    JSON.stringify(read['settings']) !== JSON.stringify(SETTINGS)
  ) {
    throw new Error('unexpected measurement configuration');
  }
  interval(read, ordered);
  const scenarios = read['scenarios'];
  if (!Array.isArray(scenarios) || scenarios.length !== 2) {
    throw new Error('expected both connection scenarios');
  }
  for (const [index, scenario] of scenarios.entries()) {
    scenarioOf(scenario, index);
  }
  return read as unknown as Run;
}

function answeredBoth(pair: Pair): boolean {
  return pair.vercel.headersMs !== null && pair.arkor.headersMs !== null;
}

export function parseMeasurement(value: unknown): Measurement {
  const read = object(value);
  base(read);
  if (read['schemaVersion'] !== SCHEMA_VERSION) {
    throw new Error('unsupported measurement schema');
  }
  if (
    read['protocol'] !== PROTOCOL ||
    JSON.stringify(read['targets']) !== JSON.stringify(TARGETS)
  ) {
    throw new Error('unexpected benchmark protocol or targets');
  }
  if (read['status'] === 'success') {
    const run = runOf(read['run']);
    if (run.startedAt !== read['startedAt'] || run.finishedAt !== read['finishedAt']) {
      throw new Error('measurement timestamps disagree');
    }
    const empty = run.scenarios.some((scenario) => {
      const answered = scenario.pairs.some((pair) => answeredBoth(pair));
      return !answered;
    });
    if (empty) {
      throw new Error('a scenario had no pair both sides answered within its budget');
    }
  } else if (read['status'] === 'failure') {
    text(read['error']);
    if (read['run'] !== undefined) {
      // Preserve observed raw wall times as evidence even when the clock caused the failure.
      runOf(read['run'], false);
    }
  } else {
    throw new Error('unknown measurement outcome');
  }
  return read as unknown as Measurement;
}

export function resultPath(attempt: Identity): string {
  return `runs/${attempt.runId}-${String(attempt.runAttempt)}.json`;
}

export function parseIndex(value: unknown): Index {
  const read = object(value);
  if (read['schemaVersion'] !== SCHEMA_VERSION || !Array.isArray(read['attempts'])) {
    throw new Error('unsupported feed schema');
  }
  const sequence = integer(read['sequence'], 1);
  iso(read['publishedAt']);
  if (read['attempts'].length > SUCCESS_LIMIT + FAILURE_LIMIT) {
    throw new Error('feed exceeds its retention bound');
  }
  let last = 0;
  const ids = new Set<string>();
  const attempts = read['attempts'];
  for (const valueOfAttempt of attempts) {
    const attempt = object(valueOfAttempt);
    base(attempt);
    if (object(attempt['source'])['ref'] !== 'refs/heads/main') {
      throw new Error('canonical feed only accepts main branch provenance');
    }
    const current = integer(attempt['sequence'], last + 1, sequence);
    const id = `${String(attempt['runId'])}-${String(attempt['runAttempt'])}`;
    if (ids.has(id)) {
      throw new Error('duplicate published workflow attempt');
    }
    ids.add(id);
    last = current;
    if (attempt['status'] === 'success') {
      const expected = resultPath(attempt as unknown as Identity);
      if (attempt['result'] !== expected) {
        throw new Error('invalid immutable result path');
      }
    } else if (attempt['status'] === 'failure') {
      text(attempt['error']);
    } else {
      throw new Error('unknown published outcome');
    }
  }
  if (last !== sequence) {
    throw new Error('feed lost its last publication');
  }
  return read as unknown as Index;
}

export function sourceFromEnv(env: NodeJS.ProcessEnv = process.env): Source {
  const runId = env['GITHUB_RUN_ID'] ?? '';
  return sourceOf(
    {
      repository: env['GITHUB_REPOSITORY'],
      workflow: WORKFLOW,
      ref: env['GITHUB_REF'],
      sha: env['GITHUB_SHA'],
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
      runner: {
        os: boundedText(env['RUNNER_OS'] ?? process.platform),
        arch: boundedText(env['RUNNER_ARCH'] ?? process.arch),
        imageOS: boundedText(env['ImageOS'] ?? 'unavailable'),
        imageVersion: boundedText(env['ImageVersion'] ?? 'unavailable'),
        node: process.version,
      },
    },
    runId,
  );
}
