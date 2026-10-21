import { compareCodeUnits } from '@stayingupwind/core/util';
import type { RetireScopeInput, RetireScopeResult } from '@stayingupwind/host/cache';

import {
  type AccountScope,
  deleteScript,
  listDeployments,
  type ScriptSummary,
  type WorkerDeployment,
} from './cloudflare/workers.ts';
import { type EdgeHistory, functionsRemain, pointerOf, readHistory, scriptsOf } from './history.ts';
import type { ProjectNames } from './names.ts';

/**
 * The deployments a project keeps, and the Functions of the rest deleted (P11): run after a
 * deployment is made live, while the deploy agent still answers, so that each deleted deployment's
 * scope of the runtime cache is retired as well.
 *
 * Kept: every deployment the edge's deployment holds, the one this run made, and the newest
 * `keep` others a rollback could still go back to — those whose edge version a deployment of the
 * edge can choose, and whose Functions are all there. Every other deployment loses its cache scope,
 * and then its Functions. The scope goes first: retiring one is done once however often it is
 * asked, so a run stopped before the Functions went finds them still there, and does both again.
 *
 * Before each, the edge's deployment is read again. A rollback or another deploy may have moved it
 * since this cleanup began — one deploy or rollback of a project runs at a time, but nothing on the
 * account enforces it — and where it has, the cleanup stops: nothing a version the edge's deployment
 * now holds names is ever deleted, nor anything more on the strength of an old reading.
 *
 * Functions no edge version names — a run stopped after it uploaded them and before it uploaded the
 * edge's version — are deleted as well, once they are an hour old: a run that is still going has
 * its own, and they are younger than that.
 *
 * The deployments' files stay in the bucket, and their artifacts in the namespace. Neither is
 * deleted here: what one deployment's pages ask for may be another's too.
 */

/** How old Functions no edge version names have to be before they are taken for a stopped run's. */
const ORPHAN_AGE_MS = 3_600_000;

export interface RetentionInput {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  /** How many deployments beside the live ones are kept to roll back to. */
  readonly keep: number;
  /** The deployment the run made live, kept whatever else is. */
  readonly deploymentId: string;
  /** The runtime cache's control, through the deploy agent. */
  readonly cache: { retireScope(input: RetireScopeInput): Promise<RetireScopeResult> };
  readonly now?: (() => number) | undefined;
}

export interface Retention {
  /** The deployments kept, the live ones first. */
  readonly kept: readonly string[];
  /** The deployments whose Functions were deleted. */
  readonly deleted: readonly string[];
  /** Function Workers deleted that no edge version named. */
  readonly orphans: readonly string[];
}

/** Every Function Worker the edge's deployment sends requests to, by each version it holds. */
async function heldScripts(
  scope: AccountScope,
  names: ProjectNames,
  deployment: WorkerDeployment | undefined,
): Promise<ReadonlySet<string>> {
  const held = new Set<string>();
  const shares = deployment?.versions;
  if (shares === undefined) {
    return held;
  }
  for (const share of shares) {
    const pointer = await pointerOf(scope, names.edge, share.version_id);
    if (pointer === undefined) {
      throw new Error(
        `${names.edge}'s version ${share.version_id} has no pointer this run can read, so nothing was cleaned up`,
      );
    }
    for (const script of scriptsOf(pointer)) {
      held.add(script);
    }
  }
  return held;
}

/** Which deployments stay, and which lose their Functions. */
async function sorted(
  input: RetentionInput,
  history: EdgeHistory,
): Promise<{ readonly kept: string[]; readonly doomed: string[] }> {
  const kept = [
    ...new Set([
      ...history.deployments
        .filter((record) => record.share !== undefined)
        .map((record) => record.deploymentId),
      input.deploymentId,
    ]),
  ];
  const doomed: string[] = [];
  let room = input.keep;
  for (const record of history.deployments) {
    if (kept.includes(record.deploymentId) || !history.functions.has(record.deploymentId)) {
      continue;
    }
    const pointer =
      room > 0 && record.reachable
        ? await pointerOf(input.scope, input.names.edge, record.versionId)
        : undefined;
    if (pointer !== undefined && functionsRemain(history, pointer)) {
      kept.push(record.deploymentId);
      room -= 1;
    } else {
      doomed.push(record.deploymentId);
    }
  }
  return { kept, doomed };
}

/** Function Workers no edge version names, an hour old and more, by their deployment. */
function orphansOf(history: EdgeHistory, now: number): Map<string, readonly ScriptSummary[]> {
  const tagged = new Set(history.deployments.map((record) => record.deploymentId));
  const orphans = new Map<string, readonly ScriptSummary[]>();
  for (const [deploymentId, scripts] of history.functions) {
    const old = scripts.every((script) => {
      const created = script.created_on === undefined ? NaN : Date.parse(script.created_on);
      return now - created >= ORPHAN_AGE_MS;
    });
    if (old && !tagged.has(deploymentId)) {
      orphans.set(deploymentId, scripts);
    }
  }
  return orphans;
}

/** A deployment's shares, as one string: the same shares are the same string. */
function sharesOf(deployment: WorkerDeployment): string {
  return deployment.versions
    .map((share) => `${share.version_id}=${String(share.percentage)}`)
    .toSorted(compareCodeUnits)
    .join(',');
}

/** Whether the edge's deployment is the one a cleanup began from. */
function unmoved(now: WorkerDeployment | undefined, began: WorkerDeployment | undefined): boolean {
  if (now === undefined || began === undefined) {
    return now === began;
  }
  return now.id === began.id && sharesOf(now) === sharesOf(began);
}

/**
 * The edge's deployment read again, just before a deployment loses something: the cleanup stops
 * where it moved since it began, and where a version it holds names any of these Functions.
 */
async function guard(
  input: RetentionInput,
  began: WorkerDeployment | undefined,
  deploymentId: string,
  scripts: readonly ScriptSummary[],
): Promise<void> {
  const { scope, names } = input;
  const [now] = (await listDeployments(scope, names.edge)) ?? [];
  if (!unmoved(now, began)) {
    throw new Error(
      `${names.edge}'s deployment changed while this run cleaned up, so nothing more was deleted`,
    );
  }
  const held = await heldScripts(scope, names, now);
  const live = scripts.filter((script) => held.has(script.id));
  if (live.length > 0) {
    throw new Error(
      `${live.map((script) => script.id).join(', ')} of ${deploymentId} is still sent requests by the edge, so nothing more was cleaned up`,
    );
  }
}

/** Retire a deployment's cache scope, and then delete its Functions, each after a look. */
async function remove(
  input: RetentionInput,
  began: WorkerDeployment | undefined,
  deploymentId: string,
  scripts: readonly ScriptSummary[],
): Promise<void> {
  await guard(input, began, deploymentId, scripts);
  await input.cache.retireScope({ scopeId: deploymentId, reason: 'upwind deploy retention' });
  await guard(input, began, deploymentId, scripts);
  for (const script of scripts) {
    await deleteScript(input.scope, script.id, { force: true });
  }
}

/** Keep what a project keeps, and delete the Functions of the rest. */
export async function retainDeployments(input: RetentionInput): Promise<Retention> {
  const history = await readHistory(input.scope, input.names);
  const began = history.current;
  const { kept, doomed } = await sorted(input, history);
  for (const deploymentId of doomed) {
    await remove(input, began, deploymentId, history.functions.get(deploymentId) ?? []);
  }
  const orphans: string[] = [];
  const stopped = orphansOf(history, (input.now ?? Date.now)());
  for (const [deploymentId, scripts] of stopped) {
    await remove(input, began, deploymentId, scripts);
    orphans.push(...scripts.map((script) => script.id));
  }
  return { kept, deleted: doomed, orphans };
}
