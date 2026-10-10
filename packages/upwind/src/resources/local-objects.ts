import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type DurableObjectDeclaration,
  durableObjectDeclarationsSchema,
} from '@stayingupwind/core/bundle';
import { UPWIND_DURABLE_OBJECTS_ENV } from '@stayingupwind/core/paas';

import { resolveFromProject } from '../dev/next-app.ts';
import { watchDependencies, watchFile, watchManifests } from './watch-sources.ts';

export interface LocalDurableObject {
  readonly declaration: DurableObjectDeclaration;
  readonly source: string;
  readonly inputs: readonly string[];
  readonly wasmModules?: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}

function fileInBuildError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('location' in error)) return undefined;
  const { location } = error;
  if (typeof location !== 'object' || location === null || !('file' in location)) return undefined;
  return typeof location.file === 'string' ? location.file : undefined;
}

function watchBuildErrors(projectDir: string, error: unknown, watchedFiles: Set<string>): void {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('errors' in error) ||
    !Array.isArray(error.errors)
  )
    return;
  for (const failure of error.errors as unknown[]) {
    const file = fileInBuildError(failure);
    if (file !== undefined && file !== '<stdin>') watchedFiles.add(path.resolve(projectDir, file));
  }
}

function warnBuildFailure(
  projectDir: string,
  error: unknown,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): void {
  watchBuildErrors(projectDir, error, watchedFiles);
  for (const file of watchedFiles) watchFile(file, watchedFiles, versions);
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `upwind: could not prepare a local Durable Object; other local resources remain available:\n${reason}`,
  );
}

async function durableObjectsOf(
  projectDir: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
  mode: 'development' | 'production',
): Promise<readonly LocalDurableObject[]> {
  const raw = process.env[UPWIND_DURABLE_OBJECTS_ENV];
  if (raw === undefined || raw === '') return [];
  const declarations = durableObjectDeclarationsSchema.parse(JSON.parse(raw) as unknown);
  if (declarations.length === 0) return [];
  watchDependencies(projectDir, watchedFiles, versions);
  for (const declaration of declarations)
    watchFile(path.resolve(projectDir, declaration.module), watchedFiles, versions);
  const adapter = resolveFromProject(projectDir, '@stayingupwind/adapter');
  if (adapter === undefined)
    throw new Error('install @stayingupwind/adapter to run local Durable Objects');
  const module = (await import(pathToFileURL(adapter).href)) as {
    bundleDurableObjects?: (
      directory: string,
      objects: readonly DurableObjectDeclaration[],
      options: {
        readonly mode: 'development' | 'production';
        readonly onSourceFile: (file: string) => void;
      },
    ) => Promise<LocalDurableObject[]>;
  };
  if (module.bundleDurableObjects === undefined)
    throw new Error(
      'the installed adapter does not support Durable Objects; install matching upwind packages',
    );
  const bundle = module.bundleDurableObjects;
  const options = {
    mode,
    onSourceFile: (file: string) => {
      watchFile(file, watchedFiles, versions);
      watchManifests(file, watchedFiles, versions);
    },
  };
  // Deployment builds remain atomic; local preparation preserves independently healthy classes.
  const settled = await Promise.allSettled(
    declarations.map((declaration) => bundle(projectDir, [declaration], options)),
  );
  const objects: LocalDurableObject[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') objects.push(...result.value);
    else warnBuildFailure(projectDir, result.reason, watchedFiles, versions);
  }
  for (const object of objects)
    for (const file of object.inputs) {
      watchFile(file, watchedFiles, versions);
      watchManifests(file, watchedFiles, versions);
    }
  return objects;
}

/** A broken class stays watched and never takes away the project's other local storage. */
export async function localObjects(
  projectDir: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
  mode: 'development' | 'production',
): Promise<readonly LocalDurableObject[]> {
  try {
    return await durableObjectsOf(projectDir, watchedFiles, versions, mode);
  } catch (error) {
    warnBuildFailure(projectDir, error, watchedFiles, versions);
    return [];
  }
}
