import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, assert, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { FUNCTION_COMPATIBILITY_DATE, FUNCTION_COMPATIBILITY_FLAGS } from '../src/function.ts';
import { bundleLinkedExternals } from '../src/linked-externals.ts';
import { tracedFiles } from '../src/traced-files.ts';
import { replaceTypescriptLibDirectory, typescriptLibDirectory } from '../src/vfs-typescript.ts';

const DIRECTORY = '/bundle/node_modules/typescript/lib';
const SOURCE = `var requirePath = function requirePath() {
  return require(String.fromCharCode(112, 97, 116, 104));
};
exports.directories = function(option) {
  var path = requirePath();
  return [
    option || path.dirname(require.resolve('typescript')),
    option || path.dirname(require.resolve('typescript')),
    option ?? path.dirname(require.resolve('typescript')),
  ];
};
exports.shadowed = function(require) {
  var path = requirePath();
  return path.dirname(require.resolve('typescript'));
};`;
const LOCAL_CALLS = `result = [
  exports.directories(undefined), exports.directories('/custom/lib'), exports.directories(''),
  exports.shadowed({resolve() {return '/local/typescript.js';}})
];`;
const EXPECTED = [
  [DIRECTORY, DIRECTORY, DIRECTORY],
  ['/custom/lib', '/custom/lib', '/custom/lib'],
  [DIRECTORY, DIRECTORY, ''],
  '/local',
];
const LINKED = 'vfs-fixture-1111111111111111';

async function fixture(owner = '@typescript/vfs') {
  const root = await mkdtemp(path.join(tmpdir(), 'upwind-vfs-library-'));
  const distDir = path.join(root, '.next');
  const vfs = path.join(root, 'node_modules', '@typescript', 'vfs');
  const lib = path.join(root, 'node_modules', 'typescript', 'lib');
  const linked = path.join(distDir, 'node_modules', LINKED);
  await mkdir(path.join(distDir, 'server', 'chunks'), { recursive: true });
  await mkdir(vfs, { recursive: true });
  await mkdir(lib, { recursive: true });
  await mkdir(linked, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"vfs-test-project"}');
  await writeFile(
    path.join(vfs, 'package.json'),
    JSON.stringify({ name: owner, main: 'index.cjs' }),
  );
  const importer = path.join(vfs, 'index.cjs');
  await writeFile(importer, SOURCE);
  await writeFile(
    path.join(lib, '..', 'package.json'),
    '{"name":"typescript","main":"lib/typescript.js"}',
  );
  await writeFile(path.join(lib, 'typescript.js'), 'module.exports = {};');
  const declaration = path.join(lib, 'lib.d.ts');
  await writeFile(declaration, 'interface String {}');
  await writeFile(
    path.join(linked, 'package.json'),
    JSON.stringify({ name: LINKED, type: 'module', exports: './index.mjs' }),
  );
  await writeFile(
    path.join(linked, 'index.mjs'),
    "export { directories, shadowed } from '@typescript/vfs';",
  );
  const files = tracedFiles(
    [{ assets: { 'node_modules/typescript/lib/lib.d.ts': declaration } }],
    root,
    distDir,
  );
  return { root, distDir, importer, declaration, files };
}

describe('vfs TypeScript peer library resolution', () => {
  const roots: string[] = [];
  const runtimes: Miniflare[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('rewrites all three free dirname sites and preserves explicit options and local require bindings', () => {
    const state: { exports: Record<string, unknown>; result: unknown } = {
      exports: {},
      result: undefined,
    };
    const require = (id: string) => {
      assert.equal(id, 'path');
      return path.posix;
    };

    expect(() => {
      // eslint-disable-next-line sonarjs/code-eval -- only this fixed test module runs, with a path-only loader stub.
      runInNewContext(`${SOURCE}\n${LOCAL_CALLS}`, { ...state, require });
    }).toThrow('require.resolve is not a function');

    const rewritten = replaceTypescriptLibDirectory(SOURCE, DIRECTORY);
    assert.ok(rewritten !== undefined);

    expect(rewritten.edits).toBe(3);

    const observed = { ...state, require };
    // eslint-disable-next-line sonarjs/code-eval -- evaluate only the adapter's rewrite of the fixed test module.
    runInNewContext(`${rewritten.code.toString()}\n${LOCAL_CALLS}`, observed);

    // Compare values after crossing the VM realm, whose Array prototype is distinct.
    expect(structuredClone(observed.result)).toStrictEqual(EXPECTED);
  });

  it.each([
    "(require) => path.dirname(require.resolve('typescript'))",
    "function f() {var require; return path.dirname(require.resolve('typescript'));}",
    "{const require = {}; path.dirname(require.resolve('typescript'));}",
    "try {} catch(require) {path.dirname(require.resolve('typescript'));}",
    "for(let require of []) {path.dirname(require.resolve('typescript'));}",
    "import require from 'local'; path.dirname(require.resolve('typescript'));",
    "(class require {method() {return path.dirname(require.resolve('typescript'));}})",
  ])('leaves lexically bound lookups untouched: %s', (source) => {
    expect(replaceTypescriptLibDirectory(source, DIRECTORY)).toBeUndefined();
  });

  it.each([
    "require.resolve('typescript')",
    "path.dirname(require.resolve('typescript', {}))",
    "path.dirname(require['resolve']('typescript'))",
    "path.dirname(require?.resolve('typescript'))",
    "const path = custom; path.dirname(require.resolve('typescript'))",
    "const {custom:path} = require('path'); path.dirname(require.resolve('typescript'))",
    "const path = require('path'); ((path) => path.dirname(require.resolve('typescript')))({})",
    "let path = require('path'); path = custom; path.dirname(require.resolve('typescript'))",
    "const requirePath = () => custom; const path = requirePath(); path.dirname(require.resolve('typescript'))",
    "var requirePath = function require(){return require('path')}; var path=requirePath(); path.dirname(require.resolve('typescript'))",
    "var requirePath = function String(){return require(String.fromCharCode(112,97,116,104))}; var path=requirePath(); path.dirname(require.resolve('typescript'))",
    "const path = require('path'); path.dirname = custom; path.dirname(require.resolve('typescript'))",
    "const String = custom; const requirePath = () => require(String.fromCharCode(112,97,116,104)); const path = requirePath(); path.dirname(require.resolve('typescript'))",
    "let requirePath = () => require('path'); const path = requirePath(); requirePath = custom; path.dirname(require.resolve('typescript'))",
  ])('rejects an unsupported free lookup or path binding: %s', (source) => {
    expect(() => replaceTypescriptLibDirectory(source, DIRECTORY)).toThrow(AuditError);
  });

  it.each([
    "const path = require('node:path');",
    "import path from 'node:path';",
    "import * as path from 'path';",
  ])('supports the checked Node path namespace binding: %s', (binding) => {
    const rewritten = replaceTypescriptLibDirectory(
      `${binding} path.dirname(require.resolve('typescript'))`,
      DIRECTORY,
    );
    assert.ok(rewritten !== undefined);

    expect(rewritten.edits).toBe(1);
    expect(rewritten.code.toString()).toContain(DIRECTORY);
  });

  it('refuses a computed resolver in the actual package transform', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    await writeFile(
      setup.importer,
      "const path = require('path'); exports.directories = () => path.dirname(require['resolve']('typescript'));",
    );

    await expect(
      bundleLinkedExternals({
        projectDir: setup.root,
        files: setup.files,
        distDir: setup.distDir,
        workDir: setup.root,
        kind: 'app',
        ids: [LINKED],
      }),
    ).rejects.toThrow('unsupported free TypeScript resolver');
  });

  it("uses the actual peer and only this Function's explicitly traced declaration mount", async () => {
    const setup = await fixture();
    roots.push(setup.root);

    await expect(typescriptLibDirectory(setup.importer, setup.root, setup.files)).resolves.toBe(
      DIRECTORY,
    );
    await expect(typescriptLibDirectory(setup.importer, setup.root, [])).rejects.toThrow(
      AuditError,
    );
  });

  it('rejects two logical mounts of the same physical peer library', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    const alternate = path.join(setup.root, 'alternate', 'node_modules');
    await mkdir(alternate, { recursive: true });
    await symlink(
      path.dirname(path.dirname(setup.declaration)),
      path.join(alternate, 'typescript'),
      'dir',
    );
    const alias = {
      name: 'alternate/node_modules/typescript/lib/lib.d.ts',
      filePath: setup.declaration,
    };

    await expect(
      typescriptLibDirectory(setup.importer, setup.root, [...setup.files, alias]),
    ).rejects.toThrow('unambiguous');
  });

  it.each([
    { owner: '@typescript/vfs', expected: EXPECTED },
    { owner: 'unrelated-package', expected: { name: 'TypeError' } },
  ])(
    'checks real package identity before emitting a resolver repair for $owner',
    async ({ owner, expected }) => {
      const setup = await fixture(owner);
      roots.push(setup.root);
      const linked = await bundleLinkedExternals({
        projectDir: setup.root,
        files: setup.files,
        distDir: setup.distDir,
        workDir: setup.root,
        kind: 'app',
        ids: [LINKED],
      });
      assert.ok(linked !== undefined);
      const modules = await Promise.all(
        linked.modules.map(async (module) => {
          const contents = await readFile(module.file, 'utf8');
          return { type: 'ESModule' as const, path: `/bundle/${module.name}`, contents };
        }),
      );
      const worker = `export default {async fetch() {
        try {
          const api = await import('./${LINKED}');
          const exports = api;
          let result;
          ${LOCAL_CALLS}
          return Response.json(result);
        } catch(error) {return Response.json({name: error.name});}
      }};`;
      const runtime = new Miniflare(
        convertV4MiniflareOptions({
          name: 'vfs-peer-library',
          compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
          compatibilityFlags: [...FUNCTION_COMPATIBILITY_FLAGS],
          modulesRoot: '/bundle',
          modules: [{ type: 'ESModule', path: '/bundle/test.mjs', contents: worker }, ...modules],
          cf: false,
          telemetry: { enabled: false },
          log: new Log(LogLevel.NONE),
          outboundService() {
            throw new Error('VFS resolver tests cannot use outbound network');
          },
        }),
      );
      runtimes.push(runtime);
      const response = await runtime.dispatchFetch('https://vfs.test/', {
        signal: AbortSignal.timeout(5000),
      });
      const actual: unknown = await response.json();

      expect(actual).toStrictEqual(expected);
    },
    20_000,
  );
});
