import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlobStore } from '../../src/blobs.ts';
import { jsLiteral } from '../../src/codegen.ts';
import type { BuildFunctionInput } from '../../src/function.ts';
import { nodeCachePolicyPatch } from '../../src/node-cache-policy.ts';
import type { NodePhysicalFiles } from '../../src/node-files.ts';
import { proveNodeManifests } from '../../src/node-manifest-proof.ts';
import {
  certifyNodeNextRewrites,
  nodeNextRewriteMetadata,
} from '../../src/node-next-rewrite-proof.ts';
import { instrumentationPatch } from '../../src/patches/instrumentation.ts';
import type { AppliedPatch } from '../../src/patches/rolldown.ts';
import { WasmCollector } from '../../src/wasm.ts';
import { nodeManifestTemplateGraphFixture } from './node-manifest-template-graph.ts';

export function rewriteDigest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Primary Next bytes and authored graph metadata only; no source is evaluated. */
async function rewriteFixture(directory: string, mode: 'none' | 'own' | 'composed' = 'none') {
  const own = await nodeManifestTemplateGraphFixture(directory, 'pages');
  const root = path.join(directory, 'node_modules/next');
  const runtime = path.join(root, 'dist/compiled/next-server/pages.runtime.prod.js');
  const loaderName = 'dist/server/lib/router-utils/instrumentation-globals.external.js';
  const loader = path.join(root, loaderName);
  const loaderCode = await readFile(
    fileURLToPath(import.meta.resolve(`next/${loaderName}`)),
    'utf8',
  );
  await mkdir(path.dirname(loader), { recursive: true });
  await writeFile(loader, loaderCode);
  own.graph.sources.set(loader, { file: loader, sha256: rewriteDigest(loaderCode) });
  own.graph.importers.set(loader, [runtime]);
  own.graph.imports.set(loader, []);
  own.graph.imports.get(runtime)?.push({ specifier: `next/${loaderName}`, target: loader });
  own.graph.retained.add(loader);
  const config = path.join(own.input.distDir, 'required-server-files.json');
  await writeFile(config, '{"config":{"experimental":{}}}');
  let hook: string | undefined;
  let projectHook: string | undefined;
  async function put(file: string, code: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, code);
    own.graph.sources.set(file, { file, sha256: rewriteDigest(code) });
    own.graph.imports.set(file, []);
    own.graph.importers.set(file, []);
    own.graph.retained.add(file);
  }
  if (mode !== 'none') {
    projectHook = path.join(own.input.distDir, 'server/instrumentation.js');
    await put(projectHook, 'exports.register=async()=>{};');
    hook = projectHook;
    if (mode === 'composed') {
      hook = path.join(directory, '.upwind/instrumentation.cjs');
      await put(hook, `exports.register=()=>require(${jsLiteral(projectHook)}).register();`);
      own.graph.imports.set(hook, [{ specifier: projectHook, target: projectHook }]);
      own.graph.importers.set(projectHook, [hook]);
    }
    const analysisEntry = own.input.analysisEntry;
    const entryCode = `${await readFile(analysisEntry, 'utf8')}\nmodule.exports.instrumentation=()=>require(${jsLiteral(hook)});`;
    await writeFile(analysisEntry, entryCode);
    own.graph.sources.set(analysisEntry, { file: analysisEntry, sha256: rewriteDigest(entryCode) });
    own.graph.imports.get(analysisEntry)?.push({ specifier: hook, target: hook });
    own.graph.imports.set(loader, [{ specifier: hook, target: hook }]);
    own.graph.importers.set(hook, [analysisEntry, loader]);
  }
  const input: BuildFunctionInput = {
    kind: 'app',
    projectDir: directory,
    repoRoot: directory,
    outDir: path.join(directory, '.upwind'),
    entries: own.input.entries,
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: own.input.runtimeManifest,
    cacheHostModule: undefined,
    blobs: [],
    files: [],
    blobStore: new BlobStore(path.join(directory, '.upwind')),
    patch: {
      projectDir: directory,
      distDir: own.input.distDir,
      chunks: [],
      instrumentation: hook,
      wasm: [],
    },
  };
  const manifestInput = { ...own.input, instrumentation: hook };
  const manifests = await proveNodeManifests(manifestInput, own.graph);
  const runtimeCode = await readFile(runtime, 'utf8');
  const patches: AppliedPatch[] = [
    {
      file: runtime,
      patch: nodeCachePolicyPatch.name,
      result: nodeCachePolicyPatch.apply(runtimeCode, runtime, input.patch),
    },
    {
      file: loader,
      patch: instrumentationPatch.name,
      result: instrumentationPatch.apply(loaderCode, loader, input.patch),
    },
  ];
  async function certify(fresh = false) {
    const current = fresh ? await proveNodeManifests(manifestInput, own.graph) : manifests;
    return certifyNodeNextRewrites(input, own.graph, patches, current);
  }
  const proof = await certify();
  const nameOf = (file: string): string =>
    `project/${path.relative(directory, file).split(path.sep).join('/')}`;
  const sourceFiles = [...own.graph.sources.values(), ...nodeNextRewriteMetadata(proof)];
  const physical: NodePhysicalFiles = {
    files: await Promise.all(
      sourceFiles.map(async ({ file }) => {
        return {
          name: nameOf(file),
          bytes: new Uint8Array(await readFile(file)),
        };
      }),
    ),
    sourcePaths: new Map(sourceFiles.map(({ file }) => [nameOf(file), file])),
    links: [],
    cwd: 'project',
    instrumentation: projectHook,
    nameOf,
  };
  return {
    ...own,
    input,
    manifests,
    patches,
    proof,
    runtime,
    loader,
    loaderCode,
    runtimeCode,
    config,
    hook,
    projectHook,
    physical,
    certify,
  };
}

export async function nodeNextRewriteFixture(
  directory: string,
  mode: 'none' | 'own' | 'composed' = 'none',
): Promise<Awaited<ReturnType<typeof rewriteFixture>>> {
  return rewriteFixture(directory, mode);
}
