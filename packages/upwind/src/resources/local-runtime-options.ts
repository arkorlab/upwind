import path from 'node:path';

import { CLOUDFLARE_WORKFLOW_EXPORT, DURABLE_OBJECT_EXPORT } from '@stayingupwind/core/bundle';
import type { ResourceType } from '@stayingupwind/core/paas';
import type { MiniflareOptions } from 'miniflare';

import { type LocalAi, localAiBinding } from './local-ai.ts';
import type { LocalStorageEntry } from './local-bindings.ts';
import type { LocalDurableObject } from './local-objects.ts';
import type { LocalCloudflareWorkflow } from './local-workflows.ts';

/**
 * The compatibility date the local runtime runs at.
 *
 * The date `@stayingupwind/adapter` builds a Function against (`FUNCTION_COMPATIBILITY_DATE`), so
 * that local storage behaves as a deployment's does rather than as whatever the installed runtime
 * defaults to. Written out rather than imported: this CLI resolves the adapter from the project it
 * was pointed at and does not depend on the package, so a release that moves that date moves this
 * line with it.
 */
const COMPATIBILITY_DATE = '2026-09-15';

/** Local storage and Workflow state live under this project-owned directory. */
export const PERSIST_DIR = '.upwind';

/** The one worker there is. Its name appears in the storage paths, so it does not change. */
export const WORKER_NAME = 'upwind-local';

/**
 * The runtime insists a worker have code. This one answers nothing and is never sent a request: it
 * exists so that its bindings do, and those are reached from Node rather than from a request.
 */
const ENTRY_MODULE = 'upwind-local.mjs';
const ENTRY_SOURCE = 'export default {};';

/** What the local runtime calls each kind of storage the contract names. */
export const DURABLE_OBJECT_TYPE = 'durable_object_namespace';
const DURABLE_OBJECT_KIND = 'durable-object';

const RUNTIME_TYPES = {
  d1: 'd1',
  kv_namespace: 'kv',
  r2_bucket: 'r2',
  [DURABLE_OBJECT_TYPE]: DURABLE_OBJECT_KIND,
} as const satisfies Record<Exclude<ResourceType, 'ai' | 'workflow'>, string>;

function workflowWorkerName(name: string): string {
  return `upwind-workflow-${name}`;
}

function ownerName(name: string): string {
  return `upwind-object-${name}`;
}

type LocalBinding =
  | ReturnType<typeof localAiBinding>
  | { type: 'd1' | 'kv'; id: string }
  | { type: 'r2'; name: string }
  | { type: typeof DURABLE_OBJECT_KIND; worker: string; exportName: string }
  | { type: 'workflow'; name: string; worker: string; exportName: string };

export interface LocalRuntimeOptions {
  readonly entries: readonly LocalStorageEntry[];
  readonly objects: readonly LocalDurableObject[];
  readonly ai: LocalAi;
  readonly workflows: readonly LocalCloudflareWorkflow[];
}

/** Independent local worker modules share the same project resource identities. */
export function runtimeOptions(projectDir: string, input: LocalRuntimeOptions): MiniflareOptions {
  const { entries, objects, ai, workflows } = input;
  const env = Object.fromEntries<LocalBinding>(
    entries.map((entry): [string, LocalBinding] => {
      if (entry.type === 'ai') return [entry.name, localAiBinding()];
      if (entry.type === 'workflow')
        return [
          entry.name,
          {
            type: 'workflow',
            name: workflowWorkerName(entry.name),
            worker: workflowWorkerName(entry.name),
            exportName: CLOUDFLARE_WORKFLOW_EXPORT,
          },
        ];
      if (entry.type === DURABLE_OBJECT_TYPE)
        return [
          entry.name,
          {
            type: DURABLE_OBJECT_KIND,
            worker: ownerName(entry.name),
            exportName: DURABLE_OBJECT_EXPORT,
          },
        ];
      const id = `${entry.storageName ?? entry.name}-${WORKER_NAME}`;
      return [
        entry.name,
        entry.type === 'r2_bucket'
          ? { type: 'r2' as const, name: id }
          : { type: RUNTIME_TYPES[entry.type], id },
      ];
    }),
  );
  return {
    resourcePersistencePath: path.join(projectDir, PERSIST_DIR),
    workers: [
      {
        config: {
          name: WORKER_NAME,
          compatibilityDate: COMPATIBILITY_DATE,
          manifest: {
            mainModule: ENTRY_MODULE,
            modules: { [ENTRY_MODULE]: { type: 'esm', contents: ENTRY_SOURCE } },
          },
          // Keep the original default identifiers when the same storage is bound to an owner
          // Worker too; otherwise each owner's constructor would receive a separate database.
          env,
        },
      },
      ...(ai.worker === undefined ? [] : [ai.worker]),
      ...workflows.map((workflow) => {
        return {
          config: {
            name: workflowWorkerName(workflow.declaration.name),
            compatibilityDate: COMPATIBILITY_DATE,
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: ENTRY_MODULE,
              modules: {
                [ENTRY_MODULE]: { type: 'esm' as const, contents: workflow.source },
                ...Object.fromEntries(
                  (workflow.wasmModules ?? []).map((module) => {
                    return [
                      module.name,
                      { type: 'wasm' as const, contents: new Uint8Array(module.bytes) },
                    ];
                  }),
                ),
              },
            },
            env,
          },
        };
      }),
      ...objects.map((object) => {
        const modules: Record<
          string,
          {
            type: 'esm' | 'wasm';
            contents: string | Uint8Array<ArrayBuffer>;
          }
        > = { [ENTRY_MODULE]: { type: 'esm', contents: object.source } };
        if (object.wasmModules !== undefined)
          for (const module of object.wasmModules)
            modules[module.name] = { type: 'wasm', contents: new Uint8Array(module.bytes) };
        return {
          config: {
            name: ownerName(object.declaration.name),
            compatibilityDate: COMPATIBILITY_DATE,
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: ENTRY_MODULE,
              modules,
            },
            exports: {
              [DURABLE_OBJECT_EXPORT]: {
                type: DURABLE_OBJECT_KIND,
                storage: 'sqlite',
              } as const,
            },
            env,
          },
        };
      }),
    ],
  };
}
