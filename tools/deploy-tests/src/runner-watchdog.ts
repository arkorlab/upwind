import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { listedSuites } from './results.ts';

/**
 * Runs Next.js's test runner (`run-tests.js`, the command after `--`) and watches it. Where every
 * suite the shard listed (`expected-tests.txt` in `--results`) has left its result in `--next-dir`
 * and the runner has still not ended `--quiet-ms` after the last of them, a Jest process that wrote
 * its result has not exited, and the runner waits on it: on 2026-10-27 and 2026-10-28 one such
 * process held a shard until its time limit. What the processes are doing then is written to the log,
 * each Jest process still running is ended, and the suites it ran are named beside the results
 * (`watchdog.json`) for the verdict. The runner's own exit code is this script's.
 */

/** How long after the last result a runner that has not ended is taken to be waiting on Jest. */
const DEFAULT_QUIET_MS = 300_000;
/** How often the results are looked at. */
const DEFAULT_POLL_MS = 30_000;
/** How long an ended Jest process is given to go after SIGTERM before it is killed. */
const TERM_GRACE_MS = 10_000;
const SECOND_MS = 1000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'next-dir': { type: 'string' },
    results: { type: 'string' },
    'quiet-ms': { type: 'string', default: String(DEFAULT_QUIET_MS) },
    'poll-ms': { type: 'string', default: String(DEFAULT_POLL_MS) },
  },
});
const nextDir = values['next-dir'];
const resultsDir = values.results;
const [command, ...args] = positionals;
if (nextDir === undefined || resultsDir === undefined || command === undefined) {
  throw new Error('runner-watchdog: --next-dir, --results and a command after -- are required');
}
const quietMs = Number(values['quiet-ms']);
const pollMs = Number(values['poll-ms']);

interface Process {
  readonly pid: number;
  readonly ppid: number;
  readonly args: string;
}

/** A line of `ps -o pid=,ppid=,args=`: two numbers, then the command line as it is. */
function parsedProcess(line: string): Process | undefined {
  const fields = line
    .trim()
    .split(' ')
    .filter((field) => field !== '');
  const [pid, ppid] = fields;
  if (pid === undefined || ppid === undefined || !/^\d+$/u.test(pid) || !/^\d+$/u.test(ppid)) {
    return undefined;
  }
  return { pid: Number(pid), ppid: Number(ppid), args: fields.slice(2).join(' ') };
}

function ps(columns: readonly string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- the runner's own ps, read for the log and nothing else.
  return execFileSync('ps', columns, { encoding: 'utf8' });
}

function processes(): Process[] {
  return ps(['-eo', 'pid=,ppid=,args='])
    .split('\n')
    .map((line) => parsedProcess(line))
    .filter((entry) => entry !== undefined);
}

/** The processes below `root`, the root not among them. */
function descendants(root: number, table: readonly Process[]): Process[] {
  const below: Process[] = [];
  const parents = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of table) {
      if (parents.has(entry.ppid) && !parents.has(entry.pid)) {
        parents.add(entry.pid);
        below.push(entry);
        grew = true;
      }
    }
  }
  return below;
}

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '(unreadable)';
  }
}

/** What a process holds open, each descriptor and what it names. */
function openFiles(pid: number): string[] {
  const dir = `/proc/${String(pid)}/fd`;
  try {
    return readdirSync(dir).map((fd) => {
      try {
        return `  fd ${fd} -> ${readlinkSync(path.join(dir, fd))}`;
      } catch {
        return `  fd ${fd} -> (gone)`;
      }
    });
  } catch {
    return ['  fds unreadable'];
  }
}

/** What a process is doing, as the kernel says: its state, where it sleeps, and what it holds open. */
function described(pid: number): string {
  const state = read(`/proc/${String(pid)}/status`)
    .split('\n')
    .filter((line) => /^(?:State|Threads):/u.test(line))
    .join('; ');
  const wchan = read(`/proc/${String(pid)}/wchan`);
  return [`pid ${String(pid)}: ${state}; waiting in ${wchan}`, ...openFiles(pid)].join('\n');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const listing = path.join(resultsDir, 'expected-tests.txt');
const suites = existsSync(listing) ? listedSuites(readFileSync(listing, 'utf8')) : [];

/** When the last of the listed suites left its result, where every one of them has. */
function lastResultAt(): number | undefined {
  let last = 0;
  for (const suite of suites) {
    const file = path.join(nextDir ?? '.', `${suite}.results.json`);
    if (!existsSync(file)) {
      return undefined;
    }
    last = Math.max(last, statSync(file).mtimeMs);
  }
  return suites.length > 0 ? last : undefined;
}

const runner = spawn(command, args, { stdio: 'inherit' });
const watch = { acted: false };

function act(): void {
  watch.acted = true;
  const below = descendants(runner.pid ?? 0, processes());
  const jest = below.filter(({ args: line }) => /\bjest\b/u.test(line));
  const ended = suites.filter((suite) => jest.some(({ args: line }) => line.includes(suite)));
  const of = ended.length > 0 ? ` of ${ended.join(', ')}` : '';
  const quiet = String(Math.round(quietMs / SECOND_MS));
  const children = below.filter(({ ppid }) => jest.some(({ pid }) => pid === ppid));
  console.log(
    [
      `runner-watchdog: every listed suite left its result, and the runner has not ended ${quiet} s after the last; ending ${String(jest.length)} Jest process(es)${of}`,
      '--- processes ---',
      ps(['-eo', 'pid,ppid,pgid,etimes,stat,wchan:32,args', '--forest']),
      '--- what each Jest process is doing ---',
      ...jest.map(({ pid }) => described(pid)),
      ...children.map(({ pid, args: line }) => `child of Jest: ${line}\n${described(pid)}`),
      '--- end ---',
    ].join('\n'),
  );
  writeFileSync(path.join(resultsDir ?? '.', 'watchdog.json'), `${JSON.stringify({ ended })}\n`);
  for (const { pid } of jest) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone already.
    }
  }
  setTimeout(() => {
    for (const { pid } of jest) {
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  }, TERM_GRACE_MS).unref();
}

const watching = setInterval(() => {
  const last = lastResultAt();
  if (last !== undefined && !watch.acted && Date.now() - last >= quietMs) {
    act();
  }
}, pollMs);

runner.on('exit', (code) => {
  clearInterval(watching);
  process.exitCode = code ?? 1;
});
