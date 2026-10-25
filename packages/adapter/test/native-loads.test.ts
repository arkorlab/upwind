import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditError, auditFunction, type FunctionDependencies } from '../src/dependencies.ts';
import { dynamicLoadsInChunk } from '../src/dynamic-loads.ts';
import type { NativeAddonEntryTrace } from '../src/native-addons.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';

// Fixed official Next.js fixture, kept byte-for-byte so review is tied to its Git blob.
// https://github.com/vercel/next.js/blob/29bbeab09981148ade186e8599ecdede15abc281/test/e2e/prerender-native-module/bindings/index.js
const REVIEWED_BINDINGS =
  "// A minimal stand-in for the `bindings` npm package, reproducing only the part\n// both bundlers model: locate the calling package's root by walking up for a\n// `package.json`, then load the compiled binary from `build/Release`.\n//\n// Neither bundler evaluates this file. `@vercel/nft` maps the `bindings`\n// specifier to its own bundled copy, and Turbopack maps it to\n// `WellKnownFunctionKind::NodeBindings`; both then resolve the binary's path\n// themselves. `build/Release/<name>` is node-gyp's default output location and\n// is on both of their candidate lists, so this agrees with what they trace.\n\nconst fs = require('fs')\nconst path = require('path')\n\nfunction getCallerFile() {\n  const { prepareStackTrace } = Error\n  try {\n    Error.prepareStackTrace = (_error, stack) => stack\n    for (const frame of new Error().stack) {\n      const fileName = frame.getFileName()\n      if (typeof fileName === 'string' && fileName !== __filename) {\n        return fileName\n      }\n    }\n  } finally {\n    Error.prepareStackTrace = prepareStackTrace\n  }\n  throw new Error('bindings: could not determine the calling file')\n}\n\nfunction getPackageRoot(file) {\n  let dir = path.dirname(file)\n  while (!fs.existsSync(path.join(dir, 'package.json'))) {\n    const parent = path.dirname(dir)\n    if (parent === dir) {\n      throw new Error(`bindings: found no package.json above ${file}`)\n    }\n    dir = parent\n  }\n  return dir\n}\n\nmodule.exports = function bindings(name) {\n  const binary = path.join(\n    getPackageRoot(getCallerFile()),\n    'build',\n    'Release',\n    name\n  )\n\n  if (!fs.existsSync(binary)) {\n    throw new Error(\n      `bindings: ${binary} does not exist. The fixture addon is compiled by ` +\n        `node-gyp during install, which requires the package to be listed in ` +\n        `the test's pnpm.onlyBuiltDependencies.`\n    )\n  }\n\n  // Deliberately not wrapped. A non-context-aware addon fails on this line with\n  // Node's own `ERR_DLOPEN_FAILED` / \"Module did not self-register\", and the\n  // worker-thread tests assert on that message.\n  return require(binary)\n}\n";

function dependencies(chunk: OutputChunk): FunctionDependencies {
  const loads = dynamicLoadsInChunk(chunk);
  const describeLoad = (load: (typeof loads)[number]): string =>
    `${load.file}:${load.line}: ${load.text}`;
  return {
    buildOutput: [],
    packages: {},
    other: [],
    externals: [],
    stubs: [],
    patches: [],
    wasmModules: [],
    modules: [],
    size: { bytes: chunk.code.length, gzipBytes: 0 },
    dynamicRequires: loads.map(describeLoad),
    guardedRequires: loads.filter((load) => load.guarded).map(describeLoad),
  };
}

describe('retained native capability proof', () => {
  let directory: string;
  let entry: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-load-proof-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.cjs');
    binary = path.join(directory, 'addon.node');
    // These bytes are never imported or executed; this suite only bundles and audits source.
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(
      path.join(directory, 'package.json'),
      '{"name":"synthetic-native-fixture","version":"1.0.0"}\n',
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function bundled(source: string, traces?: readonly NativeAddonEntryTrace[]) {
    await writeFile(entry, source);
    const proof = nativeLoadsPlugin(traces ?? [{ id: '/native', assets: { entry, binary } }]);
    await using build = await rolldown({
      input: entry,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:path', 'path'],
    });
    const output = await build.generate({ format: 'cjs', exports: 'auto' });
    const chunk = output.output.find((item): item is OutputChunk => item.type === 'chunk');
    if (chunk === undefined) throw new Error('The authored fixture produced no chunk');
    return { chunk, loads: await proof.retained(chunk) };
  }

  it('classifies a retained direct native load only for the same owning importer and binary', async () => {
    const { loads } = await bundled("module.exports = () => require('./addon.node');\n");

    expect(loads).toStrictEqual([{ kind: 'direct', importer: entry, binary, owners: ['/native'] }]);
  });

  it('does not route a dead native load or build-only trace to a Container', async () => {
    const dead = await bundled("if (false) require('./addon.node'); module.exports = 42;\n");
    const traced = await bundled('module.exports = 42;\n');

    expect({ dead: dead.loads, traced: traced.loads }).toStrictEqual({ dead: [], traced: [] });
  });

  it('leaves a guarded node-gyp-build fallback untouched when no trace names a native binary', async () => {
    const loader = path.join(directory, 'node_modules/node-gyp-build');
    await mkdir(loader, { recursive: true });
    await writeFile(
      path.join(loader, 'package.json'),
      '{"name":"node-gyp-build","main":"index.js"}\n',
    );
    await writeFile(
      path.join(loader, 'index.js'),
      "module.exports=()=>{throw new Error('optional native unavailable')};\n",
    );
    const { chunk, loads } = await bundled(
      "try { module.exports=require('node-gyp-build')(__dirname); } catch { module.exports={wasm:true}; }\n",
      [{ id: '/wasm', assets: { entry } }],
    );

    expect(loads).toStrictEqual([]);
    expect(chunk.code).not.toContain('__UPWIND_NATIVE_');
    expect(() => auditFunction('app', { app: chunk.code }, dependencies(chunk))).not.toThrow(Error);
  });

  it('refuses a guarded direct native import rather than choosing a backend from its fallback', async () => {
    await expect(
      bundled(
        "try { module.exports=require('./addon.node'); } catch { module.exports={wasm:true}; }\n",
      ),
    ).rejects.toThrow('guarded native load');
  });

  it('preserves the precise plain process.dlopen fallback on the existing Worker audit path', async () => {
    const { chunk, loads } = await bundled(
      "const path=require('node:path'); try { process.dlopen(module,path.join(__dirname,'addon.node')); } catch {} module.exports={wasm:true};\n",
    );

    expect(loads).toStrictEqual([]);
    expect(chunk.code).toContain('dlopen');
    expect(() => auditFunction('app', { app: chunk.code }, dependencies(chunk))).not.toThrow(Error);
  });

  it('refuses native attribution from an unrelated route trace', async () => {
    const other = path.join(directory, 'other.cjs');
    await writeFile(other, 'module.exports = 0;\n');

    await expect(
      bundled("module.exports = require('./addon.node');\n", [
        { id: '/other', assets: { other, binary } },
      ]),
    ).rejects.toBeInstanceOf(AuditError);
  });

  it('leaves a generic dynamic loader unclassified and subject to the unchanged audit', async () => {
    const { chunk, loads } = await bundled('module.exports = (binary) => require(binary);\n');

    expect(loads).toStrictEqual([]);
    expect(() => auditFunction('app', { app: chunk.code }, dependencies(chunk))).toThrow(
      AuditError,
    );
  });

  it('does not let a proved native capability hide an unrelated dynamic loader', async () => {
    const { chunk, loads } = await bundled(
      "exports.native = require('./addon.node'); exports.custom = (binary) => require(binary);\n",
    );

    expect(loads).toHaveLength(1);
    expect(() => auditFunction('app', { app: chunk.code }, dependencies(chunk))).toThrow(
      AuditError,
    );
  });

  it('classifies a statically owned process.dlopen using the genuine node:path binding', async () => {
    const { loads } = await bundled(
      "const path = require('node:path'); process.dlopen(module, path.join(__dirname, 'addon.node')); module.exports = 42;\n",
    );

    expect(loads).toStrictEqual([{ kind: 'dlopen', importer: entry, binary, owners: ['/native'] }]);
  });

  it.each([
    "module.exports = (process) => process.dlopen(module, './addon.node');\n",
    "module.exports = (require) => require('./addon.node');\n",
  ])('never attributes a shadowed process or require binding to native Node', async (source) => {
    const { loads } = await bundled(source);

    expect(loads).toStrictEqual([]);
  });

  it.each([
    "module.exports = (module) => process.dlopen(module, './addon.node');\n",
    "module.exports = (__dirname) => process.dlopen(module, require('node:path').join(__dirname, 'addon.node'));\n",
    "const path = { join: () => './addon.node' }; process.dlopen(module, path.join(__dirname, 'addon.node')); module.exports = 42;\n",
  ])('refuses to manufacture proof from shadowed module, dirname or path', async (source) => {
    await expect(bundled(source)).rejects.toBeInstanceOf(AuditError);
  });

  it('recognizes the byte-pinned official bindings fixture only with the owned calling package binary', async () => {
    // eslint-disable-next-line sonarjs/hashing -- SHA-1 identifies the pinned upstream Git blob, not an authentication digest.
    const blob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(REVIEWED_BINDINGS)}\0`)
      .update(REVIEWED_BINDINGS)
      .digest('hex');
    const loader = path.join(directory, 'node_modules/bindings');
    const release = path.join(directory, 'build/Release');
    await mkdir(loader, { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(path.join(loader, 'package.json'), '{"name":"bindings","main":"index.js"}\n');
    await writeFile(path.join(loader, 'index.js'), REVIEWED_BINDINGS);
    const selected = path.join(release, 'addon.node');
    await writeFile(selected, new Uint8Array([3, 4, 5]));
    // This reviewed fixture selects Release directly, unlike npm bindings' broader search.
    await writeFile(path.join(directory, 'build/addon.node'), new Uint8Array([9]));
    const { loads } = await bundled("module.exports = require('bindings')('addon.node');\n", [
      { id: '/native', assets: { entry, selected } },
    ]);

    expect(blob).toBe('fd4a2e414af0b19ae18ef43baed3eaa37a918db5');
    expect(loads).toStrictEqual([
      {
        kind: 'bindings',
        importer: entry,
        binary: selected,
        owners: ['/native'],
        loaderSources: [
          {
            file: path.join(loader, 'index.js'),
            gitBlob: blob,
            sha256: createHash('sha256').update(REVIEWED_BINDINGS).digest('hex'),
          },
        ],
      },
    ]);
  });

  it('refuses the first existing reviewed-loader binary when only another candidate is owned', async () => {
    const loader = path.join(directory, 'node_modules/bindings');
    const release = path.join(directory, 'build/Release');
    await mkdir(loader, { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(path.join(loader, 'package.json'), '{"name":"bindings","main":"index.js"}\n');
    await writeFile(path.join(loader, 'index.js'), REVIEWED_BINDINGS);
    await writeFile(path.join(release, 'addon.node'), new Uint8Array([7]));
    const other = path.join(directory, 'build/addon.node');
    await writeFile(other, new Uint8Array([8]));

    await expect(
      bundled("module.exports=require('bindings')('addon.node');\n", [
        { id: '/native', assets: { entry, other } },
      ]),
    ).rejects.toThrow('first existing binary');
  });

  it('does not upgrade an unreviewed custom bindings loader to a native capability', async () => {
    const loader = path.join(directory, 'node_modules/bindings');
    await mkdir(loader, { recursive: true });
    await writeFile(path.join(loader, 'package.json'), '{"name":"bindings","main":"index.js"}\n');
    await writeFile(
      path.join(loader, 'index.js'),
      'module.exports = (binary) => require(binary);\n',
    );
    const { chunk, loads } = await bundled("module.exports = require('bindings')('addon');\n");

    expect(loads).toStrictEqual([]);
    expect(() => auditFunction('app', { app: chunk.code }, dependencies(chunk))).toThrow(
      AuditError,
    );
  });
});
