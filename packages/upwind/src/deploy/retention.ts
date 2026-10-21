import type { RetireScopeInput, RetireScopeResult } from '@stayingupwind/host/cache';

import { type AccountScope, deleteScript, type ScriptSummary } from './cloudflare/workers.ts';
import { type EdgeHistory, functionsRemain, pointerOf, readHistory, scriptsOf } from './history.ts';
import type { ProjectNames } from './names.ts';

/**
 * The deployments a project keeps, and the Functions of the rest deleted (P11): run after a
 * deployment is made live, while the deploy agent still answers, so that each deleted deployment's
 * scope of the runtime cache is retired as well.
 *
 * Kept: every deployment the edge's deployment holds, the one this run made, and the newest
 * `keep` others a rollback could still go back to — those whose edge version a deployment of the
 * edge can choose, and whose Functions are all there. Every other deployment loses its Functions,
 * after a last look that the edge's deployment does not send a request to any of them, and then its
 * cache scope, which nothing reads once its Functions are gone.
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
  history: EdgeHistory,
): Promise<ReadonlySet<string>> {
  const held = new Set<string>();
  const shares = history.current?.versions;
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

/** Delete a deployment's Functions, and then retire its cache scope. */
async function remove(
  input: RetentionInput,
  deploymentId: string,
  scripts: readonly ScriptSummary[],
  held: ReadonlySet<string>,
): Promise<void> {
  const live = scripts.filter((script) => held.has(script.id));
  if (live.length > 0) {
    throw new Error(
      `${live.map((script) => script.id).join(', ')} of ${deploymentId} is still sent requests by the edge, so nothing more was cleaned up`,
    );
  }
  for (const script of scripts) {
    await deleteScript(input.scope, script.id, { force: true });
  }
  await input.cache.retireScope({ scopeId: deploymentId, reason: 'upwind deploy retention' });
}

/** Keep what a project keeps, and delete the Functions of the rest. */
export async function retainDeployments(input: RetentionInput): Promise<Retention> {
  const history = await readHistory(input.scope, input.names);
  const held = await heldScripts(input.scope, input.names, history);
  const { kept, doomed } = await sorted(input, history);
  for (const deploymentId of doomed) {
    await remove(input, deploymentId, history.functions.get(deploymentId) ?? [], held);
  }
  const orphans: string[] = [];
  const stopped = orphansOf(history, (input.now ?? Date.now)());
  for (const [deploymentId, scripts] of stopped) {
    await remove(input, deploymentId, scripts, held);
    orphans.push(...scripts.map((script) => script.id));
  }
  return { kept, deleted: doomed, orphans };
}
