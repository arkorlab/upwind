import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type CloudflareWorkflowDeclaration,
  cloudflareWorkflowDeclarationsSchema,
} from '@stayingupwind/core/bundle';
import { UPWIND_CLOUDFLARE_WORKFLOWS_ENV } from '@stayingupwind/core/paas';

import { resolveFromProject } from '../dev/next-app.ts';
import { watchDependencies, watchFile, watchManifests } from './watch-sources.ts';

export interface LocalCloudflareWorkflow {
  readonly declaration: CloudflareWorkflowDeclaration;
  readonly source: string;
  readonly inputs: readonly string[];
  readonly wasmModules?: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}

/** A conflicting declaration cannot shadow another resource or prevent healthy local storage. */
export function independentLocalWorkflows<
  Workflow extends { readonly declaration: { readonly name: string } },
>(workflows: readonly Workflow[], occupied: readonly string[]): readonly Workflow[] {
  const reserved = new Set(occupied);
  return workflows.filter((workflow) => {
    const name = workflow.declaration.name;
    if (!reserved.has(name)) return true;
    console.warn(
      `upwind: Cloudflare Workflow binding ${name} conflicts with another resource; skipping this Workflow while other local resources remain available`,
    );
    return false;
  });
}

/** Watch failed entry modules too, so fixing a Workflow restores it on the next dev restart. */
export async function localWorkflows(
  projectDir: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
  mode: 'development' | 'production',
): Promise<readonly LocalCloudflareWorkflow[]> {
  const raw = process.env[UPWIND_CLOUDFLARE_WORKFLOWS_ENV];
  if (raw === undefined || raw === '') return [];
  try {
    const declarations = cloudflareWorkflowDeclarationsSchema.parse(JSON.parse(raw) as unknown);
    if (declarations.length === 0) return [];
    watchDependencies(projectDir, watchedFiles, versions);
    for (const declaration of declarations)
      watchFile(path.resolve(projectDir, declaration.module), watchedFiles, versions);
    const adapter = resolveFromProject(projectDir, '@stayingupwind/adapter');
    if (adapter === undefined)
      throw new Error('install @stayingupwind/adapter to run local Cloudflare Workflows');
    const loaded = (await import(pathToFileURL(adapter).href)) as {
      bundleCloudflareWorkflows?: (
        directory: string,
        declarations: readonly CloudflareWorkflowDeclaration[],
        options: {
          mode: 'development' | 'production';
          onSourceFile: (file: string) => void;
        },
      ) => Promise<LocalCloudflareWorkflow[]>;
    };
    const bundle = loaded.bundleCloudflareWorkflows;
    if (bundle === undefined)
      throw new Error('install matching upwind packages with Cloudflare Workflow support');
    const settled = await Promise.allSettled(
      declarations.map((declaration) => {
        return bundle(projectDir, [declaration], {
          mode,
          onSourceFile: (file) => {
            watchFile(file, watchedFiles, versions);
            watchManifests(file, watchedFiles, versions);
          },
        });
      }),
    );
    return settled.flatMap((result) => {
      if (result.status === 'fulfilled') return result.value;
      console.warn(
        `upwind: could not prepare a local Cloudflare Workflow:\n${String(result.reason)}`,
      );
      return [];
    });
  } catch (error) {
    console.warn(`upwind: could not prepare local Cloudflare Workflows:\n${String(error)}`);
    return [];
  }
}

interface NativeInstance {
  readonly id: string;
  status(): Promise<unknown>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(options?: unknown): Promise<void>;
  terminate(options?: unknown): Promise<void>;
  sendEvent(options: unknown): Promise<void>;
  delete(): Promise<void>;
}
interface NativeWorkflow {
  create(options?: unknown): Promise<NativeInstance>;
  createBatch(
    options: unknown,
  ): Promise<NativeInstance[] | { created: NativeInstance[]; errors: unknown[] }>;
  get(id: string): Promise<NativeInstance>;
}

/** Match the hosted scoped bridge while all execution and persistence stays on this machine. */
export function localWorkflowBridge(binding: unknown): {
  invoke(request: { method: string; id?: string; options?: unknown }): Promise<unknown>;
} {
  const workflow = binding as NativeWorkflow;
  return {
    async invoke(request: { method: string; id?: string; options?: unknown }): Promise<unknown> {
      if (request.method === 'create') return { id: (await workflow.create(request.options)).id };
      if (request.method === 'createBatch') {
        const result = await workflow.createBatch(request.options);
        return Array.isArray(result)
          ? result.map(({ id }) => ({ id }))
          : { ...result, created: result.created.map(({ id }) => ({ id })) };
      }
      if (request.id === undefined) throw new Error('a Workflow instance ID is required');
      const instance = await workflow.get(request.id);
      switch (request.method) {
        case 'get': {
          return { id: instance.id };
        }
        case 'status': {
          return instance.status();
        }
        case 'pause': {
          return instance.pause();
        }
        case 'resume': {
          return instance.resume();
        }
        case 'restart': {
          return instance.restart(request.options);
        }
        case 'terminate': {
          return instance.terminate(request.options);
        }
        case 'sendEvent': {
          return instance.sendEvent(request.options);
        }
        case 'delete': {
          return instance.delete();
        }
        default: {
          throw new Error('unknown Workflow operation');
        }
      }
    },
  };
}
