import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  appFunctions,
  type DeploymentBundle,
  type WorkerFunctionSpec as FunctionSpec,
} from '@stayingupwind/core/bundle';
import {
  formatResourcesManifest,
  RESOURCES_MANIFEST_BINDING,
  type ResourceType,
} from '@stayingupwind/core/paas';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { functionBindings } from '@stayingupwind/deploy/bindings';
import { prefetchBlobsOf } from '@stayingupwind/deploy/prefetch';

import { type ModulePart, type WorkerBinding, workerForm } from './cloudflare/form.ts';
import { type AccountScope, putScript } from './cloudflare/workers.ts';
import type { StorageKind } from './config.ts';
import { functionScripts, type ProjectNames } from './names.ts';
import { workerCliFunction } from './preflight.ts';
import type { MadeStorage, ProjectStores } from './stores.ts';
import { ensureWorker, holdReach, UNREACHED } from './uploads.ts';

/**
 * A deployment's Functions, each a Worker of its own: made unreachable first (`ensureWorker`), so
 * it is never on `workers.dev` or a preview URL, then uploaded with the modules the build left and
 * the bindings every Function of the deployment is given — its id, the way to its scope of the
 * runtime cache and the token that opens it, the prefetch Worker scoped to its own blobs, the
 * application's storage and its secrets. The edge reaches each by a service binding, and nothing
 * else reaches it at all.
 *
 * Each module is read from the build and checked against the digest the bundle names, as staging
 * checks a blob: what is uploaded is what was built.
 */

/** How many Functions are uploaded at once. */
const CONCURRENCY = 4;

const STORAGE_TYPES: Readonly<Record<StorageKind, ResourceType>> = {
  kv: 'kv_namespace',
  r2: 'r2_bucket',
  d1: 'd1',
};

export interface FunctionsInput {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly bundleDir: string;
  readonly bundle: DeploymentBundle;
  readonly stores: ProjectStores;
  /** The token the deployment's scope of the runtime cache opens to; none without a cache. */
  readonly token: string | undefined;
  readonly secrets: ReadonlyMap<string, string>;
  /** Whether each Function's logs are kept (Workers Logs). */
  readonly logs: boolean;
  readonly existing: ReadonlySet<string>;
}

/** A module's bytes, read from the build and checked against the digest its bundle names. */
async function partOf(
  bundleDir: string,
  module: FunctionSpec['modules'][number],
): Promise<ModulePart> {
  const bytes = new Uint8Array(await readFile(path.join(bundleDir, 'blobs', module.blob.sha256)));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== module.blob.sha256 || bytes.byteLength !== module.blob.byteLength) {
    throw new Error(`${module.name} is not the blob its bundle names (${module.blob.sha256})`);
  }
  return { name: module.name, type: module.type, bytes };
}

function storageBinding(store: MadeStorage): WorkerBinding {
  switch (store.kind) {
    case 'kv': {
      return { type: 'kv_namespace', name: store.binding, namespace_id: store.id };
    }
    case 'r2': {
      return { type: 'r2_bucket', name: store.binding, bucket_name: store.id };
    }
    case 'd1': {
      return { type: 'd1', name: store.binding, id: store.id };
    }
  }
}

function secretBinding([name, text]: readonly [string, string]): WorkerBinding {
  return { type: 'secret_text', name, text };
}

/** What every Function of the deployment is bound to. */
export function bindingsOf(input: FunctionsInput): WorkerBinding[] {
  const { names, bundle, stores, token } = input;
  const bound = functionBindings({
    deploymentId: bundle.deploymentId,
    prefetch: names.prefetch,
    prefetchBlobs: prefetchBlobsOf(bundle),
    cache:
      token === undefined
        ? undefined
        : {
            gateway: { kind: 'service', service: names.cache },
            readGateway: { kind: 'service', service: names.cacheRead },
            token,
          },
  });
  const listed = stores.storage
    .map((store) => ({ name: store.binding, type: STORAGE_TYPES[store.kind] }))
    .toSorted((a, b) => compareCodeUnits(a.name, b.name));
  return [
    ...[...input.secrets].map((secret) => secretBinding(secret)),
    ...stores.storage.map((store) => storageBinding(store)),
    ...(listed.length === 0
      ? []
      : [
          {
            type: 'plain_text',
            name: RESOURCES_MANIFEST_BINDING,
            text: formatResourcesManifest(listed),
          } as const,
        ]),
    ...bound.text.map((binding): WorkerBinding => {
      return {
        type: binding.secret ? 'secret_text' : 'plain_text',
        name: binding.name,
        text: binding.value,
      };
    }),
    ...bound.services.map((binding): WorkerBinding => {
      return {
        type: 'service',
        name: binding.name,
        service: binding.service,
        ...(binding.entrypoint !== undefined && { entrypoint: binding.entrypoint }),
        ...(binding.props !== undefined && { props: binding.props }),
      };
    }),
  ];
}

/** Every Function of the build, by its name, beside its spec. */
function specsOf(bundle: DeploymentBundle): ReadonlyMap<string, FunctionSpec> {
  const specs = new Map<string, FunctionSpec>(
    appFunctions(bundle).map(([name, spec]) => [name, workerCliFunction(spec)]),
  );
  if (bundle.functions.middleware !== undefined) {
    specs.set('middleware', bundle.functions.middleware);
  }
  return specs;
}

async function uploadOne(
  input: FunctionsInput,
  scriptName: string,
  spec: FunctionSpec,
  bindings: readonly WorkerBinding[],
): Promise<void> {
  const main = spec.modules.filter((module) => module.name === spec.mainModule);
  if (main.length !== 1) {
    throw new Error(
      `${scriptName}'s main module ${spec.mainModule} is not one of its modules once`,
    );
  }
  const ordered = [...main, ...spec.modules.filter((module) => module.name !== spec.mainModule)];
  const parts = await Promise.all(ordered.map((module) => partOf(input.bundleDir, module)));
  await ensureWorker(input.scope, scriptName, UNREACHED, input.existing);
  await putScript(
    input.scope,
    scriptName,
    workerForm(
      {
        main_module: spec.mainModule,
        compatibility_date: spec.compatibilityDate,
        compatibility_flags: spec.compatibilityFlags,
        bindings,
        annotations: { 'workers/tag': input.bundle.deploymentId },
        ...(input.logs && { observability: { enabled: true } }),
      },
      parts,
    ),
  );
  await holdReach(input.scope, scriptName, UNREACHED);
}

/**
 * Upload every Function of the deployment, a few at once. One that fails stops the rest from taking
 * another — the run is over, and a Function uploaded after it would be one more for nothing — and
 * the failure is thrown once those being uploaded beside it have settled, so that nothing of this
 * call is still writing when it returns.
 */
export async function uploadFunctions(input: FunctionsInput): Promise<readonly string[]> {
  const specs = specsOf(input.bundle);
  const bindings = bindingsOf(input);
  const queue = [...functionScripts(input.names.project, input.bundle)];
  const uploaded: string[] = [];
  const next = async (): Promise<void> => {
    for (let script = queue.shift(); script !== undefined; script = queue.shift()) {
      const spec = specs.get(script.name);
      try {
        if (spec === undefined) {
          throw new Error(`the build has no Function called ${script.name}`);
        }
        await uploadOne(input, script.scriptName, spec, bindings);
      } catch (error) {
        queue.length = 0;
        throw error;
      }
      uploaded.push(script.scriptName);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, next));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    throw failed.reason;
  }
  return uploaded;
}
