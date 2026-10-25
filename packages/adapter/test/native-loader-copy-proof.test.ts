import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NodeArchiveFile } from '../src/node-archive.ts';
import {
  assertNodeProofFiles,
  proveNodeFunction,
  type NodeFunctionProof,
} from '../src/node-proof.ts';

// Immutable Next.js native fixture loader; source only, never executes a native addon.
// https://github.com/vercel/next.js/blob/29bbeab09981148ade186e8599ecdede15abc281/test/e2e/prerender-native-module/bindings/index.js
const REVIEWED_BINDINGS =
  "// A minimal stand-in for the `bindings` npm package, reproducing only the part\n// both bundlers model: locate the calling package's root by walking up for a\n// `package.json`, then load the compiled binary from `build/Release`.\n//\n// Neither bundler evaluates this file. `@vercel/nft` maps the `bindings`\n// specifier to its own bundled copy, and Turbopack maps it to\n// `WellKnownFunctionKind::NodeBindings`; both then resolve the binary's path\n// themselves. `build/Release/<name>` is node-gyp's default output location and\n// is on both of their candidate lists, so this agrees with what they trace.\n\nconst fs = require('fs')\nconst path = require('path')\n\nfunction getCallerFile() {\n  const { prepareStackTrace } = Error\n  try {\n    Error.prepareStackTrace = (_error, stack) => stack\n    for (const frame of new Error().stack) {\n      const fileName = frame.getFileName()\n      if (typeof fileName === 'string' && fileName !== __filename) {\n        return fileName\n      }\n    }\n  } finally {\n    Error.prepareStackTrace = prepareStackTrace\n  }\n  throw new Error('bindings: could not determine the calling file')\n}\n\nfunction getPackageRoot(file) {\n  let dir = path.dirname(file)\n  while (!fs.existsSync(path.join(dir, 'package.json'))) {\n    const parent = path.dirname(dir)\n    if (parent === dir) {\n      throw new Error(`bindings: found no package.json above ${file}`)\n    }\n    dir = parent\n  }\n  return dir\n}\n\nmodule.exports = function bindings(name) {\n  const binary = path.join(\n    getPackageRoot(getCallerFile()),\n    'build',\n    'Release',\n    name\n  )\n\n  if (!fs.existsSync(binary)) {\n    throw new Error(\n      `bindings: ${binary} does not exist. The fixture addon is compiled by ` +\n        `node-gyp during install, which requires the package to be listed in ` +\n        `the test's pnpm.onlyBuiltDependencies.`\n    )\n  }\n\n  // Deliberately not wrapped. A non-context-aware addon fails on this line with\n  // Node's own `ERR_DLOPEN_FAILED` / \"Module did not self-register\", and the\n  // worker-thread tests assert on that message.\n  return require(binary)\n}\n";

function requiredLoaderSource(
  proof: NodeFunctionProof,
  loader: string,
): NodeFunctionProof['files'][number] {
  const source = proof.files.find((entry) => entry.file === loader);
  if (source === undefined)
    throw new Error('Reviewed loader source was omitted from original proof');
  return source;
}

function replacedLoaderFiles(files: readonly NodeArchiveFile[], loader: string): NodeArchiveFile[] {
  return files.map((file) => {
    return file.name === loader
      ? { ...file, bytes: Buffer.from('module.exports=()=>require(process.env.TARGET);') }
      : file;
  });
}

describe('reviewed native loader physical closure', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-reviewed-loader-copy-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('binds reviewed loader bytes to the copied artifact even when instrumentation bundles that source', async () => {
    const distDir = path.join(directory, '.next');
    const entry = path.join(distDir, 'server/entry.cjs');
    const binary = path.join(directory, 'build/Release/addon.node');
    const loader = path.join(directory, 'node_modules/bindings/index.js');
    await mkdir(path.dirname(entry), { recursive: true });
    await mkdir(path.dirname(binary), { recursive: true });
    await mkdir(path.dirname(loader), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"name":"loader-copy-fixture"}\n');
    await writeFile(
      path.join(path.dirname(loader), 'package.json'),
      '{"name":"bindings","main":"index.js"}\n',
    );
    await writeFile(entry, "module.exports=()=>require('bindings')('addon.node');\n");
    await writeFile(loader, REVIEWED_BINDINGS);
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    const proof = await proveNodeFunction({
      kind: 'app',
      projectDir: directory,
      outDir: path.join(directory, '.arkor'),
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [{ id: '/native', assets: { entry, binary, loader } }],
      patch: { projectDir: directory, distDir, chunks: [], instrumentation: undefined, wasm: [] },
    });
    const loaderProof = requiredLoaderSource(proof, loader);
    const files = await Promise.all(
      proof.files.map(async (source) => {
        return {
          name: source.file,
          bytes: await readFile(source.file),
        };
      }),
    );
    const physical = { files, nameOf: (file: string) => file };
    const replaced = replacedLoaderFiles(files, loader);
    const hostSources = new Map([[loader, loaderProof.sha256]]);
    const retainedLoaders = proof.native[0]?.loaderSources?.map((source) => {
      return {
        file: source.file,
        gitBlob: source.gitBlob,
      };
    });

    expect(retainedLoaders).toStrictEqual([
      { file: loader, gitBlob: 'fd4a2e414af0b19ae18ef43baed3eaa37a918db5' },
    ]);
    expect(() => assertNodeProofFiles(proof, physical, new Map())).not.toThrow(Error);
    expect(() =>
      assertNodeProofFiles(proof, { ...physical, files: replaced }, hostSources),
    ).toThrow('absent or changed');
  });
});
