import { type EdgePointer, edgePointerSchema } from '@stayingupwind/host/delivery';

import {
  type AccountScope,
  getVersion,
  listAllVersions,
  listDeployments,
  listScripts,
  listVersions,
  type ScriptSummary,
  type WorkerDeployment,
} from './cloudflare/workers.ts';
import { deploymentOfTag } from './edge-version.ts';
import { deploymentOfScript, type ProjectNames } from './names.ts';

/**
 * What the account says of a project's deployments, read from the Workers API alone: the edge's
 * versions a deploy tagged with the deployment each serves (`edgeTag`), the share of the edge's
 * traffic each holds now, and the Function Workers each deployment still has.
 *
 * A deployment is as rollbackable as two things allow. Its edge version has to be among the ones a
 * deployment of the edge can still choose — Cloudflare keeps the newest hundred so — and every
 * Function its pointer names has to be on the account still.
 */

/** A deployment of the project, as the edge's version for it says. */
export interface DeploymentRecord {
  readonly deploymentId: string;
  /** The edge's version for it: the one the edge's deployment holds, or else its newest. */
  readonly versionId: string;
  readonly number: number | undefined;
  readonly message: string | undefined;
  /** Whether a deployment of the edge can still choose the version. */
  readonly reachable: boolean;
  /** Its share of the edge's traffic; nothing where the edge's deployment does not hold it. */
  readonly share: number | undefined;
}

export interface EdgeHistory {
  /** The edge's deployment now; nothing for an edge with none, or none at all. */
  readonly current: WorkerDeployment | undefined;
  /** Every deployment an edge version is tagged with, newest first. */
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
  const records = new Map<string, DeploymentRecord>();
  for (const version of all) {
    const deploymentId = deploymentOfTag(version.annotations?.['workers/tag']);
    if (deploymentId === undefined) {
      continue;
    }
    const held = records.get(deploymentId);
    // The newest version stands for its deployment, unless an older one is the one the edge holds.
    if (held === undefined || (held.share === undefined && shares.has(version.id))) {
      records.set(deploymentId, {
        deploymentId,
        versionId: version.id,
        number: version.number,
        message: version.annotations?.['workers/message'],
        reachable: reachable.has(version.id),
        share: shares.get(version.id),
      });
    }
  }
  return { current, deployments: [...records.values()], functions };
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
