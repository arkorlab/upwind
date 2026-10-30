import type { Read, Verdict } from './judge.ts';

/** A shard's verdict, as `judge-results.ts` writes it beside its results (`verdict.json`). */
export interface ShardVerdict extends Verdict {
  readonly shard: number;
  /**
   * Whether the runner ended and said how (`runner-exit-code.txt`): not where it was stopped, at its
   * step's time limit, or never ran, after a step before it failed. Absent in a verdict from before.
   */
  readonly runnerFinished?: boolean;
  /**
   * The suites whose Jest process wrote its result and did not exit, which the watchdog ended
   * (`runner-watchdog.ts`). Their results stand; the job's log holds what the processes were doing.
   */
  readonly ended?: readonly string[];
}

/** What a summary names a lane by: the target, and the Node.js where the run names one. */
export function laneOf(target: string, node: string | undefined): string {
  return node === undefined ? target : `${target}, Node.js ${node}`;
}

/** Whether a shard's verdict fails it: as `fails` has it, or where its runner did not finish. */
export function shardFails(verdict: ShardVerdict, failed: (verdict: Verdict) => boolean): boolean {
  return failed(verdict) || verdict.runnerFinished === false;
}

/** As much of a commit as a summary names it by. */
const SHORT_COMMIT = 12;

/** The columns of a summary's table, and how each is counted from a verdict. */
const COLUMNS: readonly (readonly [string, (verdict: ShardVerdict) => number])[] = [
  ['Suites', ({ suites }) => suites.listed],
  ['Passed', ({ cases }) => cases.passed],
  ['Deploy gates', ({ cases }) => cases.gates],
  ["Reviewed: Vercel's infrastructure", ({ cases }) => cases.reviewed.vercel],
  ['Reviewed: upstream', ({ cases }) => cases.reviewed.upstream],
  ['Reviewed: the environment', ({ cases }) => cases.reviewed.environment],
  ['Skipped', ({ cases }) => cases.skipped],
  ['Failed', ({ cases }) => cases.failed],
];

function counted(count: number, what: string): string {
  return count === 1 ? `1 ${what}` : `${String(count)} ${what}s`;
}

function row(cells: readonly (number | string)[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** Where a failure was, for a list: the suite, the case where there is one, and the shard. */
function failureLine(
  shard: number,
  suite: string,
  fullName: string | undefined,
  why: string,
): string {
  const where = fullName === undefined ? `\`${suite}\`` : `\`${suite}\` › ${fullName}`;
  return `- ${where}: ${why} (shard ${String(shard)})`;
}

/** A reviewed case that passed, for a list: the suite, the case and where it is recorded. */
function recordLine({ suite, fullName, record }: Read): string {
  return `- \`${suite}\` › ${fullName} (\`REVIEWED.md#${record}\`)`;
}

/**
 * What one target's verdicts come to, as Markdown for a job's summary: the counts, then every
 * shard named in `expected` that left no verdict, every failure the reviewed cases do not account
 * for, every suite that left no result, and every case reviewed as failing that passed.
 */
export function describe(
  target: string,
  verdicts: readonly ShardVerdict[],
  expected: readonly number[] = [],
): string {
  const releases = [
    ...new Set(
      verdicts.map(({ next }) => `${next.version} (${next.commit.slice(0, SHORT_COMMIT)})`),
    ),
  ];
  const release = releases.length > 0 ? `, Next.js ${releases.join(', ')}` : '';
  const lines = [
    `### \`${target}\`${release}`,
    '',
    row(COLUMNS.map(([label]) => label)),
    row(COLUMNS.map(() => '---:')),
    row(COLUMNS.map(([, column]) => verdicts.reduce((sum, verdict) => sum + column(verdict), 0))),
  ];
  const seen = new Set(verdicts.map(({ shard }) => shard));
  const silent = expected.filter((shard) => !seen.has(shard));
  if (silent.length > 0) {
    lines.push('', `**${counted(silent.length, 'shard')} left no verdict:** ${silent.join(', ')}.`);
  }
  const ended = verdicts.flatMap(({ shard, ended: suites = [] }) =>
    suites.map((suite) => `- \`${suite}\` (shard ${String(shard)})`),
  );
  if (ended.length > 0) {
    const heading = `**${counted(ended.length, 'suite')} whose Jest process did not exit after its result, and was ended** — the job's log holds what it was doing:`;
    lines.push('', heading, '', ...ended);
  }
  const stopped = verdicts.filter(({ runnerFinished }) => runnerFinished === false);
  if (stopped.length > 0) {
    const shards = stopped.map(({ shard }) => String(shard)).join(', ');
    lines.push(
      '',
      `**${counted(stopped.length, 'shard')} whose runner did not finish:** ${shards}. Its job's log names the suite it was still running.`,
    );
  }
  const unexplained = verdicts.flatMap(({ shard, unexplained: list }) =>
    list.map(({ suite, fullName, why }) => failureLine(shard, suite, fullName, why)),
  );
  if (unexplained.length > 0) {
    const heading = `**${counted(unexplained.length, 'failure')} the reviewed cases do not account for:**`;
    lines.push('', heading, '', ...unexplained);
  }
  const missing = verdicts.flatMap(({ shard, suites }) =>
    suites.missing.map((suite) => failureLine(shard, suite, undefined, 'left no result')),
  );
  if (missing.length > 0) {
    lines.push('', `**${counted(missing.length, 'suite')} left no result:**`, '', ...missing);
  }
  const passed = verdicts.flatMap(({ passedAnyway }) =>
    passedAnyway.map((read) => recordLine(read)),
  );
  if (passed.length > 0) {
    const heading = `**${counted(passed.length, 'case')} reviewed as failing passed**, and the record may be out of date:`;
    lines.push('', heading, '', ...passed);
  }
  return `${lines.join('\n')}\n`;
}
