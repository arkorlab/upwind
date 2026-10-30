import { failureOf, type JestSuite } from './results.ts';
import type { NodeLine, Reading, ReviewedCase, RunnerTarget, Symptom } from './reviewed.ts';

/**
 * A shard's results on this machine's targets, judged against the reviewed cases (`reviewed.ts`):
 * a failure read there is counted as what it was read as, and any other failure, any suite that left
 * no result and any suite that failed outside its cases fails the shard. What it keeps is names,
 * counts and readings, as `keep-results.ts` keeps them: never a message.
 */

/** What a run measured: where, under which Node.js, and which release of Next.js. */
export interface Measured {
  readonly target: RunnerTarget;
  /**
   * The major version of the Node.js the applications were built and served under, where the run
   * names one (its lane). Absent in a verdict from before there were lanes.
   */
  readonly node?: NodeLine;
  readonly next: { readonly version: string; readonly commit: string };
}

/** A failure the reviewed cases do not account for. */
export interface Unexplained {
  readonly suite: string;
  /** Absent where the suite failed as a whole. */
  readonly fullName?: string;
  readonly why: string;
}

/** A case read by the reviewed cases: a failure accounted for, or a reviewed one that passed. */
export interface Read {
  readonly suite: string;
  readonly fullName: string;
  readonly reading: Reading;
  readonly record: string;
}

/** The readings a failure is counted under, a deploy gate's being counted as passed. */
type FailureReading = Exclude<Reading, 'deploy-gate'>;

export interface Verdict extends Measured {
  readonly version: 1;
  readonly suites: { readonly listed: number; readonly missing: readonly string[] };
  readonly cases: {
    readonly passed: number;
    /** Failed by Jest's refusal alone, on a reviewed deploy gate: counted as passed. */
    readonly gates: number;
    readonly reviewed: Readonly<Record<FailureReading, number>>;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly unexplained: readonly Unexplained[];
  readonly read: readonly Read[];
  /** Reviewed as failing on Vercel's infrastructure or on the environment, and passed. */
  readonly passedAnyway: readonly Read[];
}

/** Whether a verdict fails its shard. */
export function fails(verdict: Verdict): boolean {
  return verdict.unexplained.length > 0 || verdict.suites.missing.length > 0;
}

/** Jest's statuses for a case that did not run. */
const NOT_RUN: ReadonlySet<string> = new Set(['disabled', 'pending', 'skipped', 'todo']);

// eslint-disable-next-line no-control-regex -- the escape sequences are what is taken out
const ANSI = /\u{1B}\[[\d;]*m/gu;

/** What became of one case. */
type Outcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'passed'; readonly anyway?: Read }
  | { readonly kind: 'gate'; readonly read: Read }
  | { readonly kind: 'read'; readonly read: Read; readonly reading: FailureReading }
  | { readonly kind: 'failed'; readonly why: string };

function answers(symptom: Symptom | undefined, messages: readonly string[]): boolean {
  if (messages.length === 0) {
    return false;
  }
  return (
    symptom === undefined || messages.every((message) => symptom(message.replaceAll(ANSI, '')))
  );
}

function reviewedFor(
  measured: Measured,
  suite: string,
  fullName: string,
  reviewed: readonly ReviewedCase[],
): ReviewedCase | undefined {
  const holding = reviewed.filter((entry) => {
    return (
      entry.next.version === measured.next.version &&
      entry.next.commit === measured.next.commit &&
      entry.suite === suite &&
      (entry.targets === undefined || entry.targets.includes(measured.target)) &&
      (entry.nodes === undefined ||
        (measured.node !== undefined && entry.nodes.includes(measured.node)))
    );
  });
  // A reading for the run's own Node.js before one for every Node.js, so that a lane where a case
  // fails for its Node.js is read so; and the case's own before its suite's.
  const ranked = holding.toSorted(
    (a, b) => Number(b.nodes !== undefined) - Number(a.nodes !== undefined),
  );
  return (
    ranked.find((entry) => entry.fullName === fullName) ??
    ranked.find((entry) => entry.fullName === '*')
  );
}

/**
 * A case that passed: a deploy gate's body failed, and any other case passed. A case reviewed by
 * name as failing is listed as having passed anyway; one a suite-wide reading covers is not, since
 * such a suite holds cases that pass as well.
 */
function passedCase(entry: ReviewedCase | undefined, read: Read | undefined): Outcome {
  if (entry?.reading === 'deploy-gate') {
    return {
      kind: 'failed',
      why: 'its body failed, which upstream expects of Vercel alone (reviewed as a deploy gate)',
    };
  }
  const failsHere =
    entry?.fullName !== '*' && (read?.reading === 'vercel' || read?.reading === 'environment');
  return read !== undefined && failsHere ? { kind: 'passed', anyway: read } : { kind: 'passed' };
}

/** A case that failed, read against the reviewed case that holds for it. */
function failedCase(
  entry: ReviewedCase | undefined,
  read: Read | undefined,
  messages: readonly string[],
): Outcome {
  if (entry === undefined || read === undefined) {
    return { kind: 'failed', why: 'not reviewed' };
  }
  if (entry.reading === 'deploy-gate') {
    return failureOf(messages) === 'failing-test-passed'
      ? { kind: 'gate', read }
      : {
          kind: 'failed',
          why: `reviewed as a deploy gate (${entry.record}), but it failed otherwise than by Jest's refusal`,
        };
  }
  return answers(entry.symptom, messages)
    ? { kind: 'read', read, reading: entry.reading }
    : { kind: 'failed', why: `reviewed (${entry.record}), but it failed otherwise than recorded` };
}

function outcomeOf(
  entry: ReviewedCase | undefined,
  read: Read | undefined,
  { status, failureMessages }: JestSuite['cases'][number],
): Outcome {
  if (NOT_RUN.has(status)) {
    return { kind: 'skipped' };
  }
  if (status === 'passed') {
    return passedCase(entry, read);
  }
  return status === 'failed'
    ? failedCase(entry, read, failureMessages)
    : { kind: 'failed', why: `Jest gave it the status ${status}` };
}

/**
 * Why a suite failed as a whole, where it did, whatever its cases did. An error of the file's own —
 * an `afterAll` hook's, or the test environment's — is one Jest counts as the file's runtime error
 * (`numRuntimeErrorTestSuites`) and attaches to no case: it does so beside a failed case as well
 * (measured with Jest 29.7, which Next.js runs), so a reviewed case's failure never accounts for it.
 */
function suiteFailure(suite: JestSuite): string | undefined {
  if (suite.interrupted) {
    return 'Jest said the run was interrupted';
  }
  if (suite.runtimeError) {
    return 'Jest reported an error of the file outside its cases (a hook, or the file itself)';
  }
  return suite.status === 'failed' && suite.cases.every((entry) => entry.status !== 'failed')
    ? 'the suite failed outside its cases'
    : undefined;
}

/** A verdict as it is counted up. */
interface Tally {
  readonly cases: { passed: number; gates: number; skipped: number; failed: number };
  readonly reviewed: Record<FailureReading, number>;
  readonly unexplained: Unexplained[];
  readonly read: Read[];
  readonly passedAnyway: Read[];
}

function count(tally: Tally, suite: string, fullName: string, outcome: Outcome): void {
  switch (outcome.kind) {
    case 'skipped': {
      tally.cases.skipped += 1;
      return;
    }
    case 'passed': {
      tally.cases.passed += 1;
      if (outcome.anyway !== undefined) {
        tally.passedAnyway.push(outcome.anyway);
      }
      return;
    }
    case 'gate': {
      tally.cases.gates += 1;
      tally.read.push(outcome.read);
      return;
    }
    case 'read': {
      tally.reviewed[outcome.reading] += 1;
      tally.read.push(outcome.read);
      return;
    }
    case 'failed': {
      tally.cases.failed += 1;
      tally.unexplained.push({ suite, fullName, why: outcome.why });
    }
  }
}

/**
 * Judges the suites a shard was to run (`listed`, in the listing's order) by the result each left:
 * none where it left none, `unreadable` where what it left is not Jest's.
 */
export function judge(
  measured: Measured,
  listed: readonly string[],
  results: ReadonlyMap<string, JestSuite | 'unreadable'>,
  reviewed: readonly ReviewedCase[],
): Verdict {
  const missing: string[] = [];
  const tally: Tally = {
    cases: { passed: 0, gates: 0, skipped: 0, failed: 0 },
    reviewed: { vercel: 0, upstream: 0, environment: 0 },
    unexplained: [],
    read: [],
    passedAnyway: [],
  };
  for (const path of listed) {
    const suite = results.get(path);
    if (suite === undefined) {
      missing.push(path);
    } else if (suite === 'unreadable') {
      tally.unexplained.push({ suite: path, why: "its result could not be read as Jest's" });
    } else {
      for (const entry of suite.cases) {
        const holding = reviewedFor(measured, path, entry.fullName, reviewed);
        const read = holding && {
          suite: path,
          fullName: entry.fullName,
          reading: holding.reading,
          record: holding.record,
        };
        count(tally, path, entry.fullName, outcomeOf(holding, read, entry));
      }
      const why = suiteFailure(suite);
      if (why !== undefined) {
        tally.unexplained.push({ suite: path, why });
      }
    }
  }
  return {
    version: 1,
    target: measured.target,
    ...(measured.node !== undefined && { node: measured.node }),
    next: measured.next,
    suites: { listed: listed.length, missing },
    cases: { ...tally.cases, reviewed: tally.reviewed },
    unexplained: tally.unexplained,
    read: tally.read,
    passedAnyway: tally.passedAnyway,
  };
}
