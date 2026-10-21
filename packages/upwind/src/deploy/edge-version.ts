import { createHash } from 'node:crypto';

import type { AppRuntime } from '@stayingupwind/core/manifest';
import { functionBinding } from '@stayingupwind/host/bindings';

import type { WorkerBinding } from './cloudflare/form.ts';
import {
  type AccountScope,
  listDeployments,
  listVersions,
  putScript,
  type ScriptSubdomain,
  uploadVersion,
} from './cloudflare/workers.ts';
import type { ProjectNames } from './names.ts';
import type { WorkerScript } from './shipped.ts';
import type { ProjectStores } from './stores.ts';
import { COMPATIBILITY_DATE, ensureWorker, holdReach, shippedForm } from './uploads.ts';

/**
 * The edge's version for a deployment: the shipped edge, its pointer fixed (`POINTER`), each of the
 * deployment's Functions bound by the name the pointer gives it, and its version's own id bound
 * (`CF_VERSION_METADATA`), for the readiness answer to say which version is answering.
 *
 * The first deployment of a project creates the edge with its version live at once — there is no
 * other to keep serving. Every other one uploads a version that takes no traffic until it has been
 * checked (`activate.ts`). A version is tagged with its deployment and its pointer's digest, and a
 * run that finds one tagged as it would tag its own — a run stopped after its upload — takes that
 * one rather than uploading another.
 */

const TAG_DIGITS = 12;

export interface EdgeVersionInput {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly stores: Pick<ProjectStores, 'bucket' | 'cacheState' | 'edgeState'>;
  readonly script: WorkerScript;
  readonly pointer: string;
  readonly app: AppRuntime;
  /** Every hostname the edge is reached on, comma-separated. */
  readonly hostnames: string;
  readonly images: boolean;
  readonly reach: ScriptSubdomain;
  readonly message: string;
  readonly existing: ReadonlySet<string>;
}

export interface EdgeVersion {
  readonly versionId: string;
  /** Whether the upload made the version live, as the first one of a project is. */
  readonly live: boolean;
}

/** What the edge's version for a deployment is tagged with: the deployment, and its pointer. */
export function edgeTag(deploymentId: string, pointer: string): string {
  const digest = createHash('sha256').update(pointer).digest('hex').slice(0, TAG_DIGITS);
  return `${deploymentId}:${digest}`;
}

/** The deployment an edge version's tag names; nothing for a version of no deployment's. */
export function deploymentOfTag(tag: string | undefined): string | undefined {
  const deploymentId = tag?.split(':', 1)[0];
  return deploymentId?.startsWith('dpl_') === true ? deploymentId : undefined;
}

function serviceBinding(service: string): WorkerBinding {
  return { type: 'service', name: functionBinding(service), service };
}

/** The Functions the pointer names, each as the binding the edge reaches it by. */
function functionBindings(app: AppRuntime): WorkerBinding[] {
  const scripts = new Set([
    app.scriptName,
    ...(app.middlewareScriptName === undefined ? [] : [app.middlewareScriptName]),
    ...Object.values(app.functions ?? {}),
  ]);
  return [...scripts].map((service) => serviceBinding(service));
}

function bindingsOf(input: EdgeVersionInput): WorkerBinding[] {
  const { names, stores } = input;
  return [
    { type: 'kv_namespace', name: 'EDGE_STATE', namespace_id: stores.edgeState },
    { type: 'kv_namespace', name: 'CACHE_STATE', namespace_id: stores.cacheState },
    { type: 'r2_bucket', name: 'ARTIFACTS', bucket_name: stores.bucket },
    { type: 'plain_text', name: 'POINTER', text: input.pointer },
    { type: 'plain_text', name: 'HOSTNAMES', text: input.hostnames },
    { type: 'service', name: 'CACHE_SIGNALS', service: names.cache, entrypoint: 'CacheSignals' },
    { type: 'version_metadata', name: 'CF_VERSION_METADATA' },
    ...(input.images ? [{ type: 'images', name: 'IMAGES' } as const] : []),
    ...functionBindings(input.app),
  ];
}

/** Upload the edge's version for the deployment, or take the one a stopped run uploaded. */
export async function uploadEdgeVersion(input: EdgeVersionInput): Promise<EdgeVersion> {
  const { scope, names } = input;
  const tag = edgeTag(input.app.deploymentId, input.pointer);
  const deployments = input.existing.has(names.edge)
    ? await listDeployments(scope, names.edge)
    : undefined;
  const first = deployments === undefined || deployments.length === 0;
  if (!first) {
    const versions = await listVersions(scope, names.edge);
    const uploaded = versions.find((version) => version.annotations?.['workers/tag'] === tag);
    if (uploaded !== undefined) {
      return { versionId: uploaded.id, live: false };
    }
  }
  const form = shippedForm(input.script.script, {
    compatibility_date: COMPATIBILITY_DATE,
    // The edge compresses as it serves, with `node:zlib`.
    compatibility_flags: ['nodejs_compat'],
    bindings: bindingsOf(input),
    annotations: { 'workers/tag': tag, 'workers/message': input.message },
  });
  if (!first) {
    const version = await uploadVersion(scope, names.edge, form);
    // `deploy.workersDev` may have changed since the edge was made.
    await holdReach(scope, names.edge, input.reach);
    return { versionId: version.id, live: false };
  }
  await ensureWorker(scope, names.edge, input.reach, input.existing);
  await putScript(scope, names.edge, form);
  await holdReach(scope, names.edge, input.reach);
  const [live] = (await listDeployments(scope, names.edge)) ?? [];
  const versionId = live?.versions[0]?.version_id;
  if (versionId === undefined) {
    throw new Error(`${names.edge} was uploaded, and Cloudflare names no version of it live`);
  }
  return { versionId, live: true };
}
