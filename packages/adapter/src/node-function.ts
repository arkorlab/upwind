import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import type { NativeLoad } from './native-loads.ts';
import { nodeArtifactArchive } from './node-archive.ts';
import { NodeArtifactFiles } from './node-artifact-files.ts';
import { nodePhysicalFiles } from './node-files.ts';
import {
  addNodeEdge,
  addNodeRuntime,
  addNodeServer,
  assertNativeAbi,
  assertNativeSelection,
  assertNodeTarget,
  bundleNodeInstrumentation,
  type NodeBuiltFunction,
} from './node-function-parts.ts';
import {
  archivedNodeJwtGuardRecords,
  archivedNodeNextRequireHook,
} from './node-jwt-compiler-archive.ts';
import { nodeJwtCompilerMetadata } from './node-jwt-compiler-proof.ts';
import { nodeNextRequireHookMetadata } from './node-next-require-hook-proof.ts';
import type { NodeNextRewriteProof } from './node-next-rewrite-proof.ts';
import {
  assertFinalOriginalNodeModes,
  nodeOriginalModeMetadata,
  nodeOriginalModeProofFiles,
} from './node-original-load-mode-archive.ts';
import { usePhysicalOriginalNodeModes } from './node-original-load-mode.ts';
import {
  assertNodeProofFiles,
  nodeProofRawSources,
  proveNodeFunction,
  type NodeFunctionProof,
} from './node-proof.ts';
import { buildServerNodeFunction } from './node-server-function.ts';
import { nodeSourceMaps } from './node-source-maps.ts';
import { nodeWsLoaderMetadata } from './node-ws-loader-proof.ts';

export type { NodeBuiltFunction } from './node-function-parts.ts';

/**
 * What a Node Function's artifact carries: `'proved'`, the closure its original graph proves;
 * `'server'`, the whole server output, as `next start` reads it, with only its native loads proved.
 */
export type NodeFunctionFiles = 'proved' | 'server';

async function addNodeInstrumentation(
  files: NodeArtifactFiles,
  work: string,
  nextRewrites: NodeNextRewriteProof | undefined,
): Promise<ReadonlyMap<string, string>> {
  if (files.input.patch.instrumentation === undefined) return new Map();
  const hook = path.join(work, 'instrumentation.cjs');
  const originals = await bundleNodeInstrumentation(files.input, {
    outFile: hook,
    nameOf: files.physical.nameOf,
    instrumentation: files.physical.instrumentation,
    nextRewrites,
  });
  const bytes = new Uint8Array(await readFile(hook));
  files.sealInstrumentation(originals, bytes);
  files.add('upwind/instrumentation.cjs', bytes);
  return originals;
}

/** Add the sources and caller metadata needed by the fixed initialization guards. */
async function nodeInitializationMetadata(originalProof: NodeFunctionProof) {
  const jwtMetadata =
    originalProof.jwtCompiler === undefined
      ? undefined
      : await nodeJwtCompilerMetadata(originalProof.jwtCompiler);
  const wsMetadata =
    originalProof.wsLoaders === undefined
      ? undefined
      : await nodeWsLoaderMetadata(originalProof.wsLoaders);
  const hookMetadata =
    originalProof.nextRequireHook === undefined
      ? undefined
      : await nodeNextRequireHookMetadata(originalProof.nextRequireHook);
  return [
    ...nodeProofRawSources(originalProof),
    ...(originalProof.normalization?.metadataFiles ?? []),
    ...(jwtMetadata?.files ?? []),
    ...(jwtMetadata?.callers ?? []),
    ...(wsMetadata?.files ?? []),
    ...(wsMetadata?.callers ?? []),
    ...(hookMetadata?.files ?? []),
    ...(hookMetadata?.callers ?? []),
  ];
}

/** A separate physical artifact; app modules are never passed through the Worker patch bundle. */
export async function buildNodeFunction(
  input: BuildFunctionInput,
  selected: readonly NativeLoad[],
  carries: NodeFunctionFiles = 'proved',
): Promise<NodeBuiltFunction> {
  if (selected.length === 0)
    throw new AuditError('A Node Function requires a retained, owned native load');
  if (carries === 'server') return await buildServerNodeFunction(input, selected);
  const originalProof = await proveNodeFunction(input);
  const native = originalProof.native;
  assertNativeSelection(selected, native);
  assertNodeTarget(input, native);
  const abi = assertNativeAbi();
  const metadata = await nodeInitializationMetadata(originalProof);
  const physical = await nodePhysicalFiles(input, native, metadata, {
    selectModeMetadata: async (sourcePaths) => {
      await usePhysicalOriginalNodeModes(originalProof.originalModes, sourcePaths);
      return nodeOriginalModeMetadata(originalProof.originalModes);
    },
    nextRewrites: originalProof.nextRewrites,
  });
  const proof = {
    ...originalProof,
    files: nodeOriginalModeProofFiles(originalProof.originalModes, originalProof.files),
  };
  const files = new NodeArtifactFiles(input, physical, native, proof.nextRewrites);
  const work = path.join(input.outDir, 'work', `node-${input.name ?? input.kind}`);
  await mkdir(work, { recursive: true });
  const instrumentation = await addNodeInstrumentation(files, work, proof.nextRewrites);
  assertNodeProofFiles(proof, physical, instrumentation, nodeProofRawSources(originalProof));
  files.rewriteNextFiles();
  await files.addNativeMetadata();
  await files.addNextManifests();
  await files.addPlatformFiles();
  await files.addAppEntry(proof.normalization);
  await addNodeEdge(files, work);
  files.addWasm();
  await addNodeRuntime(files, work);
  const guards = await archivedNodeJwtGuardRecords(
    proof.jwtCompiler,
    files,
    proof.nextRewrites,
    proof.wsLoaders,
  );
  const nextHook = await archivedNodeNextRequireHook(
    proof.nextRequireHook,
    files,
    proof.nextRewrites,
  );
  await addNodeServer(files, work, guards, nextHook);
  await files.assertAppEntryNormalization(proof.normalization);
  await files.assertNextRewrites();
  await assertFinalOriginalNodeModes(proof.originalModes, {
    files: files.files,
    sourcePaths: physical.sourcePaths,
    links: physical.links,
    nameOf: physical.nameOf,
  });
  const finalGuards = await archivedNodeJwtGuardRecords(
    proof.jwtCompiler,
    files,
    proof.nextRewrites,
    proof.wsLoaders,
  );
  if (JSON.stringify(finalGuards) !== JSON.stringify(guards))
    throw new AuditError(
      'Node dependency initialization records changed during bootstrap generation',
    );
  const finalNextHook = await archivedNodeNextRequireHook(
    proof.nextRequireHook,
    files,
    proof.nextRewrites,
  );
  if (JSON.stringify(finalNextHook) !== JSON.stringify(nextHook))
    throw new AuditError('Next require hook records changed during bootstrap generation');
  const archiveFiles = [...files.files.values()];
  const archive = nodeArtifactArchive(archiveFiles);
  const bytes = archiveFiles.reduce((total, file) => total + file.bytes.byteLength, 0);
  const artifact = await input.blobStore.put(archive, 'application/gzip');
  return {
    spec: { runtime: 'node-container', artifact, entrypoint: 'upwind/server.mjs', abi },
    sourceMaps: await nodeSourceMaps(input, physical, files.files),
    inputs: physical.files.map((file) => ({ file: file.name, bytes: file.bytes.byteLength })),
    dependencies: {
      ...proof.dependencies,
      size: { bytes, gzipBytes: archive.byteLength },
    },
  };
}
