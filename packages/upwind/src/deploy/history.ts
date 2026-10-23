import { type EdgePointer, edgePointerSchema } from '@stayingupwind/host/delivery';

import { unlessMissing } from './cloudflare/client.ts';
import {
  type AccountScope,
  getVersion,
  listAllVersions,
  listDeployments,
  listScripts,
  listVersions,
  type ScriptSummary,
  type WorkerDeployment,
  type WorkerVersion,
} from './cloudflare/workers.ts';
import { deploymentOfTag } from './edge-version.ts';
import { keyIdOf } from './infra.ts';
import { deploymentOfScript, type ProjectNames } from './names.ts';

/**
 * What the account says of a project's deployments, read from the Workers API alone: the edge's
 * versions a deploy tagged with the deployment each serves (`edgeTag`), the share of the edge's
 * traffic each holds now, and the Function Workers each deployment still has.
 *
 * A deployment is as rollbackable as two things allow. Its edge version has to be among the ones a
 * deployment of the edge can still choose — Cloudflare keeps the newest hundred so — and every
 * Function its pointer names has to be on the account still.
 *
 * Deployments are ordered by when each was first deployed: its oldest edge version's number. A
 * deployment published again — rolled back to — gets a new version, and is no newer a deployment
 * for it. The way back from the live deployment (`wayBackOrder`) goes to deployments first deployed
 * before it, the one the edge gave traffic to most recently first: one that was live before it,
 * rather than one that never was, or one the live deployment was rolled back to replace.
 */

/** How a version ranks to stand for its deployment. */
const HELD_WITH_TRAFFIC = 3;
const HELD = 2;
const SERVED = 1;
const UNSERVED = 0;

/** A deployment of the project, as the edge's version for it says. */
export interface DeploymentRecord {
  readonly deploymentId: string;
  /**
   * The edge's version for it: the one the edge's deployment gives traffic to, or holds at none;
   * or else the newest that one of the edge's deployments gave traffic to; or else its newest. A
   * deployment deployed again gets a version of its own each time, and one that failed its checks
   * is no better a way back than the one that served it.
   */
  readonly versionId: string;
  readonly number: number | undefined;
  readonly message: string | undefined;
  /** Whether a deployment of the edge can still choose the version. */
  readonly reachable: boolean;
  /** Its share of the edge's traffic; nothing where the edge's deployment does not hold it. */
  readonly share: number | undefined;
  /**
   * When it was first deployed, as the edge numbers its versions: the number of the oldest version
   * tagged with it. Higher is later; only the order means anything.
   */
  readonly firstDeployed: number;
  /**
   * How many of the edge's deployments, as Cloudflare lists them, ago one of its versions last had
   * traffic: 0 for the current one, 1 for the one before. Nothing where none listed gave it any.
   */
  readonly lastServed: number | undefined;
}

export interface EdgeHistory {
  /** The edge's deployment now; nothing for an edge with none, or none at all. */
  readonly current: WorkerDeployment | undefined;
  /** Every deployment an edge version is tagged with, the one first deployed most recently first. */
  readonly deployments: readonly DeploymentRecord[];
  /** The project's Function Workers on the account, by the deployment each belongs to. */
  readonly functions: ReadonlyMap<string, readonly ScriptSummary[]>;
}

function groupFunctions(
  project: string,
  scripts: readonly ScriptSummary[],
): Map<string, ScriptSummary[]> {
  const grouped = new Map<string, ScriptSummary[]>();
  for (const script of scripts) {
    const deploymentId = deploymentOfScript(project, script.id);
    if (deploymentId !== undefined) {
      grouped.set(deploymentId, [...(grouped.get(deploymentId) ?? []), script]);
    }
  }
  return grouped;
}

/** Read what the account says of the project's deployments. */
export async function readHistory(scope: AccountScope, names: ProjectNames): Promise<EdgeHistory> {
  const [deployments, scripts] = await Promise.all([
    listDeployments(scope, names.edge),
    listScripts(scope),
  ]);
  const functions = groupFunctions(names.project, scripts);
  if (deployments === undefined) {
    return { current: undefined, deployments: [], functions };
  }
  const [current] = deployments;
  const [deployable, all] = await Promise.all([
    listVersions(scope, names.edge),
    listAllVersions(scope, names.edge),
  ]);
  const reachable = new Set(deployable.map((version) => version.id));
  const shares = new Map(
    (current?.versions ?? []).map((share) => [share.version_id, share.percentage]),
  );
  const served = servedVersions(deployments);
  // What stands for a deployment among its versions: the one the edge gives traffic to, then one
  // it holds at none, then one that has served, then any; the newest of the best.
  const rank = (versionId: string): number => {
    const share = shares.get(versionId);
    if (share !== undefined) {
      return share > 0 ? HELD_WITH_TRAFFIC : HELD;
    }
    return served.has(versionId) ? SERVED : UNSERVED;
  };
  const tagged = taggedVersions(all);
  const lastServed = lastServedOf(deployments, tagged);
  const records = new Map<string, DeploymentRecord>();
  for (const { version, deploymentId, number } of tagged) {
    const standing = records.get(deploymentId);
    // Newest first, so a later version replaces one only by ranking above it; the oldest seen last
    // says when the deployment was first deployed.
    const firstDeployed = Math.min(standing?.firstDeployed ?? number, number);
    if (standing === undefined || rank(version.id) > rank(standing.versionId)) {
      records.set(deploymentId, {
        deploymentId,
        versionId: version.id,
        number: version.number,
        message: version.annotations?.['workers/message'],
        reachable: reachable.has(version.id),
        share: shares.get(version.id),
        firstDeployed,
        lastServed: lastServed.get(deploymentId),
      });
    } else {
      records.set(deploymentId, { ...standing, firstDeployed });
    }
  }
  const ordered = [...records.values()].toSorted((a, b) => b.firstDeployed - a.firstDeployed);
  return { current, deployments: ordered, functions };
}

/**
 * The edge's versions a deploy tagged, newest first, each with its deployment and its number — or,
 * for a listing that numbers none, its place counted from the oldest, which orders them the same.
 */
function taggedVersions(all: readonly WorkerVersion[]): readonly {
  readonly version: WorkerVersion;
  readonly deploymentId: string;
  readonly number: number;
}[] {
  const tagged: { version: WorkerVersion; deploymentId: string; number: number }[] = [];
  for (const [index, version] of all.entries()) {
    const deploymentId = deploymentOfTag(version.annotations?.['workers/tag']);
    if (deploymentId !== undefined) {
      tagged.push({ version, deploymentId, number: version.number ?? all.length - index });
    }
  }
  return tagged;
}

/** How many of the edge's listed deployments ago each deployment last had traffic. */
function lastServedOf(
  deployments: readonly WorkerDeployment[],
  tagged: readonly { readonly version: WorkerVersion; readonly deploymentId: string }[],
): ReadonlyMap<string, number> {
  const deploymentOf = new Map(tagged.map((one) => [one.version.id, one.deploymentId]));
  const last = new Map<string, number>();
  for (const [index, deployment] of deployments.entries()) {
    for (const share of deployment.versions) {
      const deploymentId = deploymentOf.get(share.version_id);
      if (deploymentId !== undefined && share.percentage > 0 && !last.has(deploymentId)) {
        last.set(deploymentId, index);
      }
    }
  }
  return last;
}

/**
 * The order the way back is tried in, and kept in: a deployment the edge gave traffic to more
 * recently first — the one live before, over one that never was live, or one replaced by being
 * rolled back from — and among those alike, the one first deployed most recently.
 */
export function wayBackOrder(a: DeploymentRecord, b: DeploymentRecord): number {
  if (a.lastServed !== b.lastServed) {
    if (a.lastServed === undefined) {
      return 1;
    }
    return b.lastServed === undefined ? -1 : a.lastServed - b.lastServed;
  }
  return b.firstDeployed - a.firstDeployed;
}

/** Every version one of the edge's deployments, as Cloudflare lists them, gave traffic to. */
function servedVersions(deployments: readonly WorkerDeployment[]): ReadonlySet<string> {
  const served = new Set<string>();
  for (const deployment of deployments) {
    for (const share of deployment.versions) {
      if (share.percentage > 0) {
        served.add(share.version_id);
      }
    }
  }
  return served;
}

/** The pointer an edge version was uploaded with; nothing where it was uploaded with none. */
export async function pointerOf(
  scope: AccountScope,
  edge: string,
  versionId: string,
): Promise<EdgePointer | undefined> {
  const version = await getVersion(scope, edge, versionId);
  const binding = version.resources?.bindings?.find(
    (candidate) => candidate.type === 'plain_text' && candidate.name === 'POINTER',
  );
  if (binding?.text === undefined) {
    return undefined;
  }
  try {
    const parsed = edgePointerSchema.safeParse(JSON.parse(binding.text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every Function Worker a pointer sends requests to. */
export function scriptsOf(pointer: EdgePointer): readonly string[] {
  const app = pointer.app;
  if (app === undefined) {
    return [];
  }
  return [
    ...new Set([
      app.scriptName,
      ...(app.middlewareScriptName === undefined ? [] : [app.middlewareScriptName]),
      ...Object.values(app.functions ?? {}),
    ]),
  ];
}

/** A listing's newest version: the one numbered highest, whatever order the listing is in. */
function newestOf(versions: readonly WorkerVersion[]): WorkerVersion | undefined {
  let newest: WorkerVersion | undefined;
  for (const version of versions) {
    if (newest === undefined || (version.number ?? 0) > (newest.number ?? 0)) {
      newest = version;
    }
  }
  return newest;
}

/** When a version was uploaded, as Cloudflare dates it; nothing where it does not. */
function uploadedAt(version: WorkerVersion | undefined): number | undefined {
  const at = Date.parse(version?.metadata?.created_on ?? '');
  return Number.isNaN(at) ? undefined : at;
}

/**
 * When the key the runtime cache's Workers check a Function's token with now was made: when the
 * oldest version of the cache tagged with its id (`ensureInfra`) was uploaded. A key is put in the
 * cache before any Function holding a token signed under it is uploaded, in the run that made it.
 *
 * Only where that version is known to be the oldest with the key (Sentry): one before it is listed,
 * under another key or none, or it is the cache's first. The listing stops at the newest thousand
 * versions, and Cloudflare may keep fewer; where the oldest listed carries the key, the key may be
 * older than it, and a later time would take deployments made under the key for ones made before
 * it. Nothing then — a rollback refuses no deployment for the key — as for a project with no cache
 * Worker, one whose newest version says nothing of a key, or one whose versions are not numbered.
 */
export async function cacheKeyMadeAt(
  scope: AccountScope,
  names: ProjectNames,
): Promise<number | undefined> {
  const versions = (await unlessMissing(listAllVersions(scope, names.cache))) ?? [];
  const keyId = keyIdOf(newestOf(versions)?.annotations?.['workers/tag']);
  if (keyId === undefined || versions.some((version) => version.number === undefined)) {
    return undefined;
  }
  let first: WorkerVersion | undefined;
  for (const version of versions) {
    const keyed = keyIdOf(version.annotations?.['workers/tag']) === keyId;
    if (keyed && (first === undefined || (version.number ?? 0) < (first.number ?? 0))) {
      first = version;
    }
  }
  const from = first?.number ?? 0;
  const known = from === 1 || versions.some((version) => (version.number ?? 0) < from);
  return known ? uploadedAt(first) : undefined;
}

/**
 * Whether a Function the pointer names was last uploaded before `madeAt`, when the runtime cache's
 * key was made (`cacheKeyMadeAt`): its token was signed under the key before — reset since
 * (`--reset-cache-key`) — which the cache no longer takes, and nothing but uploading the Function
 * again gives it another. A Function Cloudflare dates no upload of, or one no longer there, is not
 * known to.
 */
export async function uploadedBefore(
  scope: AccountScope,
  pointer: EdgePointer,
  madeAt: number,
): Promise<boolean> {
  const listed = await Promise.all(
    scriptsOf(pointer).map((script) => unlessMissing(listVersions(scope, script))),
  );
  return listed.some((versions) => {
    const at = uploadedAt(newestOf(versions ?? []));
    return at !== undefined && at < madeAt;
  });
}

/** Whether every Function the pointer names is on the account. */
export function functionsRemain(history: EdgeHistory, pointer: EdgePointer): boolean {
  const deploymentId = pointer.app?.deploymentId;
  const present = new Set(
    (deploymentId === undefined ? [] : (history.functions.get(deploymentId) ?? [])).map(
      (script) => script.id,
    ),
  );
  const named = scriptsOf(pointer);
  return named.length > 0 && named.every((script) => present.has(script));
}
