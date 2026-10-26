import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProjectConfig } from './config.ts';

/**
 * One project, one fixture at a time.
 *
 * Every deployment **replaces** the project's whole runtime environment, so two fixtures deploying
 * into one project do not queue behind each other: the second takes the first's environment away while
 * its tests are still running, and what fails is the first, for a reason nothing in its own output
 * explains. The suite's harness runs suites in parallel when asked to (`run-tests.js -c`), so the rule
 * is kept here rather than hoped for — a run that cannot have the project says so instead of deploying
 * into one somebody else is using.
 *
 * The mechanism is `packages/upwind/src/resources/local.ts`'s, for the same reason it is that there:
 * **a file per claim, rather than one file passed between them.** A shared file can only be taken over
 * by removing it, and a removal by path cannot tell the claim it read from the one that replaced it a
 * moment later — two runs finding the same abandoned claim would each delete the other's and both go
 * on. A name nobody else writes has no such step: the only entry a run ever removes is its own, and
 * those of runs whose application is gone.
 *
 * Written first and read second: a run that reads before writing can be read as absent by somebody
 * doing the same at the same moment, and then both go on. This way the only pair that can miss each
 * other is one that started in the same instant, and what they both do then is stand down —
 * over-cautious once, rather than wrong.
 *
 * **What marks a claim spent is the application, not the process.** The deploy hook exits as soon as it
 * has printed the URL, and the tests run after it; a claim tied to that process would be given back
 * before the thing it protects had begun. So a claim names the isolated application the suite's harness
 * made, and is spent when that directory is gone — which is what the harness does with it once the
 * suite is over. The cleanup hook gives it back sooner, in the ordinary case.
 *
 * **This is one machine's rule, and it cannot be more than that.** The claims live in this machine's
 * temporary directory, so a run here and a run on a runner see none of each other and both proceed —
 * and the project's environment goes to whichever deployed last, while the other's tests are still
 * running. Nothing in the API can be borrowed to do better: it has no lock, and the one piece of state
 * both runs share is the very thing being taken away. So the rest is arranged so the case does not
 * arise — the workflow that dispatches this run takes a `concurrency` group, which is the same rule
 * between runners, and a second project is what a second machine needs. Said in the README, because it
 * is the operator's to know, not something this file can enforce.
 */

const DIGEST_CHARACTERS = 16;
/** A path-sized claim, bounded like the tool's other local policy files. */
const MAX_CLAIM_BYTES = 65_536;
const GROUP_AND_OTHER_PERMISSIONS = 0o077;
const CLAIM_MODE = 0o600;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function privateDirectory(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  // eslint-disable-next-line no-bitwise -- POSIX permission bits express group and other access.
  const privateMode = (stat.mode & GROUP_AND_OTHER_PERMISSIONS) === 0;
  if (!stat.isDirectory() || (uid !== undefined && (!privateMode || stat.uid !== uid))) {
    throw new Error(`Unsafe deployment claim directory: ${dir}`);
  }
}

function readClaim(entry: string): string {
  const before = lstatSync(entry);
  if (!before.isFile()) throw new Error(`Unsafe deployment claim: ${entry}`);
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : // eslint-disable-next-line no-bitwise -- operating-system file flags are combined as a mask.
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(entry, flags);
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !stat.isFile() ||
      // One private staging alias can survive a crash immediately after publication.
      stat.nlink < 1 ||
      stat.nlink > 2 ||
      stat.size > MAX_CLAIM_BYTES ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      (uid !== undefined && stat.uid !== uid)
    ) {
      throw new Error(`Unsafe deployment claim: ${entry}`);
    }
    const bytes = Buffer.alloc(MAX_CLAIM_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_CLAIM_BYTES) throw new Error(`Deployment claim is too large: ${entry}`);
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function writePendingClaim(fd: number, value: string): void {
  try {
    writeFileSync(fd, value);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the write failure even if closing the descriptor also fails.
    }
    throw error;
  }
  closeSync(fd);
}

function writeClaim(entry: string, appDir: string): void {
  const value = path.resolve(appDir);
  if (Buffer.byteLength(value) > MAX_CLAIM_BYTES)
    throw new Error('Deployment claim path is too long');
  // Incomplete files live outside owners, so even a process exit cannot publish an empty claim.
  const pending = path.join(path.dirname(path.dirname(entry)), 'pending');
  privateDirectory(pending);
  const staged = path.join(pending, randomUUID());
  // Exclusive creation refuses symlinks without truncating anything, including on Windows.
  const fd = openSync(staged, 'wx', CLAIM_MODE);
  try {
    writePendingClaim(fd, value);
    try {
      // Linking publishes the complete, closed file and never replaces another claimant's entry.
      linkSync(staged, entry);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      if (readClaim(entry) !== value)
        throw new Error(`Conflicting deployment claim: ${entry}`, { cause: error });
    }
  } finally {
    letGo(staged);
  }
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, DIGEST_CHARACTERS);
}

/** The directory of a project's claims: named for the project, and never for the token. */
function ownersDir(config: ProjectConfig): string {
  // The origin rather than the spelling: `https://h` and `https://h/` name one host, and two runs
  // that wrote them differently would each think they had the project to themselves.
  const digest = digestOf(`${new URL(config.baseUrl).origin}\n${config.projectId}`);
  const user = process.getuid?.() ?? digestOf(os.userInfo().username);
  const root = path.join(os.tmpdir(), `upwind-deploy-claims-user-${String(user)}`);
  privateDirectory(root);
  const project = path.join(root, digest);
  privateDirectory(project);
  const owners = path.join(project, 'owners');
  privateDirectory(owners);
  return owners;
}

function entryFor(config: ProjectConfig, appDir: string): string {
  return path.join(ownersDir(config), digestOf(path.resolve(appDir)));
}

function letGo(entry: string): void {
  try {
    unlinkSync(entry);
  } catch {
    // Already gone, which is the outcome this wanted.
  }
}

/** Take the project for this fixture, or say which application already has it. */
export function claimProject(config: ProjectConfig, appDir: string): void {
  const dir = ownersDir(config);
  const mine = entryFor(config, appDir);
  writeClaim(mine, appDir);
  const held: string[] = [];
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name);
    if (entry === mine) {
      continue;
    }
    let claimed: string;
    try {
      claimed = readClaim(entry);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) continue;
      letGo(mine);
      throw error;
    }
    // Legacy writers could expose an empty claim before writing; keep those claims fail-closed.
    if (claimed === '' || existsSync(claimed)) {
      held.push(claimed || entry);
    } else {
      // The application is gone, so the claim holds nothing; the entry's own name says which it was.
      letGo(entry);
    }
  }
  const [holder] = held;
  if (holder !== undefined) {
    letGo(mine);
    throw new Error(
      `${holder} is already deployed into ${config.projectId} and is being tested. One project ` +
        "takes one fixture at a time, because a deployment replaces the project's whole " +
        `environment — run the suite serially (\`-c 1\`). If nothing is being tested, delete ${dir}/`,
    );
  }
}

/** Give the project back, as the cleanup hook does once a fixture's tests are over. */
export function releaseProject(config: ProjectConfig, appDir: string): void {
  letGo(entryFor(config, appDir));
}
