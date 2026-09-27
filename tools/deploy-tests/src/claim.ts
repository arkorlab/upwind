import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from './config.ts';

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
 */

const DIGEST_CHARACTERS = 16;

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, DIGEST_CHARACTERS);
}

/** The directory of a project's claims: named for the project, and never for the token. */
function ownersDir(config: Config): string {
  // The origin rather than the spelling: `https://h` and `https://h/` name one host, and two runs
  // that wrote them differently would each think they had the project to themselves.
  const digest = digestOf(`${new URL(config.baseUrl).origin}\n${config.projectId}`);
  return path.join(os.tmpdir(), `upwind-deploy-claims-${digest}`, 'owners');
}

function entryFor(config: Config, appDir: string): string {
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
export function claimProject(config: Config, appDir: string): void {
  const dir = ownersDir(config);
  mkdirSync(dir, { recursive: true });
  const mine = entryFor(config, appDir);
  writeFileSync(mine, path.resolve(appDir));
  const held: string[] = [];
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name);
    if (entry === mine) {
      continue;
    }
    let claimed: string;
    try {
      claimed = readFileSync(entry, 'utf8').trim();
    } catch {
      // Being written, or just removed. Either way this run has nothing to read from it.
      continue;
    }
    if (claimed !== '' && existsSync(claimed)) {
      held.push(claimed);
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
export function releaseProject(config: Config, appDir: string): void {
  letGo(entryFor(config, appDir));
}
