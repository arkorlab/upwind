import { mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { AuditError, functionDependencies } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import type { NativeLoad } from './native-loads.ts';
import { nodeArtifactArchive } from './node-archive.ts';
import { NodeArtifactFiles } from './node-artifact-files.ts';
import { nodeCachePolicyConfig } from './node-cache-policy.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from './node-files.ts';
import {
  addNodeEdge,
  addNodeRuntime,
  addNodeServer,
  assertNativeAbi,
  assertNativeSelection,
  assertNodeTarget,
  bundleNodeInstrumentation,
  CLOUDFLARE_IMPORT_PREFIX,
  type NodeBuiltFunction,
} from './node-function-parts.ts';
import { assertNodeProofFiles, selectNodeNativeLoads } from './node-proof.ts';
import { nodeSourceMaps } from './node-source-maps.ts';

const TURBOPACK_RUNTIME = '[turbopack]_runtime.js';

const RELATIVE_ROOT = /^var RELATIVE_ROOT_PATH = ("[^"\n]*");$/mu;

/** The host hook, bundled as for a proved artifact, without a proof to seal it to. */
async function addServerInstrumentation(files: NodeArtifactFiles, work: string): Promise<void> {
  if (files.input.patch.instrumentation === undefined) return;
  const hook = path.join(work, 'instrumentation.cjs');
  await bundleNodeInstrumentation(files.input, {
    outFile: hook,
    nameOf: files.physical.nameOf,
    instrumentation: files.physical.instrumentation,
    nextRewrites: undefined,
  });
  files.add('upwind/instrumentation.cjs', new Uint8Array(await readFile(hook)));
}

/**
 * Turbopack's runtime finds the project from its own distDir, `RELATIVE_ROOT_PATH` up: the artifact
 * keeps that path only where it keeps distDir and the project where they were to each other.
 */
export async function assertServerRuntimeRoot(
  distDir: string,
  nameOf: NodePhysicalFiles['nameOf'],
): Promise<void> {
  const dist = await realpath(distDir);
  const runtimes: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name === TURBOPACK_RUNTIME) runtimes.push(file);
    }
  };
  await walk(path.join(dist, 'server'));
  for (const runtime of runtimes) {
    const declared = RELATIVE_ROOT.exec(await readFile(runtime, 'utf8'))?.[1];
    if (declared === undefined)
      throw new AuditError('The Turbopack runtime does not declare its relative project root');
    const relative = String(JSON.parse(declared));
    const root = path.resolve(dist, relative);
    const carried = path.posix.relative(nameOf(dist), nameOf(root));
    if (carried !== relative.split(path.sep).join('/'))
      throw new AuditError(
        'Native Function relocation changes the Turbopack runtime root; keep distDir inside the project',
      );
  }
}

/** The whole server output, as `next start` reads it, with only the native loads proved. */
export async function buildServerNodeFunction(
  input: BuildFunctionInput,
  selected: readonly NativeLoad[],
): Promise<NodeBuiltFunction> {
  const { native, externals } = await selectNodeNativeLoads(input);
  const platform = externals.filter((specifier) => specifier.startsWith(CLOUDFLARE_IMPORT_PREFIX));
  if (platform.length > 0)
    throw new AuditError(
      `A native Function cannot load ${platform.join(', ')}: Node.js does not provide it`,
    );
  assertNativeSelection(selected, native);
  assertNodeTarget(input, native);
  const abi = assertNativeAbi();
  await nodeCachePolicyConfig(input.patch.distDir);
  const physical = await nodePhysicalFiles(input, native, [], { serverOutput: true });
  const loaders = native.flatMap((load) => load.loaderSources ?? []);
  assertNodeProofFiles({ files: loaders, native }, physical, new Map());
  await assertServerRuntimeRoot(input.patch.distDir, physical.nameOf);
  const files = new NodeArtifactFiles(input, physical, native);
  const work = path.join(input.outDir, 'work', `node-${input.name ?? input.kind}`);
  await mkdir(work, { recursive: true });
  await addServerInstrumentation(files, work);
  const patches = await files.rewriteServerFiles();
  await files.addNativeMetadata();
  await files.addNextManifests();
  await files.addPlatformFiles();
  await files.addAppEntry();
  await addNodeEdge(files, work);
  files.addWasm();
  await addNodeRuntime(files, work);
  await addNodeServer(files, work, [], undefined);
  await files.assertServerRewrites();
  const archiveFiles = [...files.files.values()];
  const archive = nodeArtifactArchive(archiveFiles);
  const bytes = archiveFiles.reduce((total, file) => total + file.bytes.byteLength, 0);
  const artifact = await input.blobStore.put(archive, 'application/gzip');
  return {
    spec: { runtime: 'node-container', artifact, entrypoint: 'upwind/server.mjs', abi },
    sourceMaps: await nodeSourceMaps(input, physical, files.files),
    inputs: physical.files.map((file) => ({ file: file.name, bytes: file.bytes.byteLength })),
    dependencies: functionDependencies(
      input.projectDir,
      input.patch.distDir,
      {
        inputs: physical.files.map((file) => {
          return {
            file: physical.sourcePaths.get(file.name) ?? file.name,
            bytes: file.bytes.byteLength,
          };
        }),
        externals,
        patches,
        stubs: [],
        wasmModules: [],
        dynamicLoads: [],
      },
      { modules: [], size: { bytes, gzipBytes: archive.byteLength } },
    ),
  };
}
