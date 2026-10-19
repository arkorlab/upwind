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

async function fixture(owner = '@typescript/vfs', nested = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'upwind-vfs-library-'));
  const projectDir = nested ? path.join(root, 'apps', 'site') : root;
  const distDir = path.join(projectDir, '.next');
  const modules = path.join(root, 'node_modules');
  const vfs = nested
    ? path.join(
        modules,
        '.pnpm',
        '@typescript+vfs@1.6.5_typescript@5.9.2',
        'node_modules',
        '@typescript',
        'vfs',
      )
    : path.join(modules, '@typescript', 'vfs');
  const typescript = nested
    ? path.join(modules, '.pnpm', 'typescript@5.9.2', 'node_modules', 'typescript')
    : path.join(modules, 'typescript');
  const lib = path.join(typescript, 'lib');
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
  if (nested) {
    await writeFile(path.join(projectDir, 'package.json'), '{"name":"nested-vfs-site"}');
    const scope = path.join(modules, '@typescript');
    await mkdir(scope, { recursive: true });
    await symlink(vfs, path.join(scope, 'vfs'), 'dir');
    await symlink(typescript, path.join(modules, 'typescript'), 'dir');
    const peers = path.dirname(path.dirname(vfs));
    await symlink(typescript, path.join(peers, 'typescript'), 'dir');
  }
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
    projectDir,
    distDir,
    root,
  );
  return { root, projectDir, distDir, importer, declaration, files };
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
        projectDir: setup.projectDir,
        repoRoot: setup.root,
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

  it('requires an explicit trusted root for a nested app with a hoisted TypeScript peer', async () => {
    const setup = await fixture('@typescript/vfs', true);
    roots.push(setup.root);

    await expect(
      typescriptLibDirectory(setup.importer, setup.projectDir, setup.files),
    ).rejects.toThrow(AuditError);
    await expect(
      typescriptLibDirectory(setup.importer, setup.projectDir, setup.files, setup.root),
    ).resolves.toBe(DIRECTORY);
  });

  it('refuses a repository root that does not lexically contain the project', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    const outside = await mkdtemp(path.join(tmpdir(), 'upwind-vfs-other-root-'));
    roots.push(outside);

    await expect(
      typescriptLibDirectory(setup.importer, setup.projectDir, setup.files, outside),
    ).rejects.toThrow('trusted repository root');
  });

  it('refuses a lexically nested project whose real directory escapes the trusted root', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    const outside = await mkdtemp(path.join(tmpdir(), 'upwind-vfs-other-project-'));
    roots.push(outside);
    const alias = path.join(setup.root, 'escaped-app');
    await symlink(outside, alias, 'dir');

    await expect(
      typescriptLibDirectory(setup.importer, alias, setup.files, setup.root),
    ).rejects.toThrow('trusted repository root');
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
    { owner: '@typescript/vfs', nested: false, expected: EXPECTED },
    { owner: '@typescript/vfs', nested: true, expected: EXPECTED },
    { owner: 'unrelated-package', nested: false, expected: { name: 'TypeError' } },
  ])(
    'checks actual peer identity for $owner in nested project $nested',
    async ({ owner, nested, expected }) => {
      const setup = await fixture(owner, nested);
      roots.push(setup.root);
      const linked = await bundleLinkedExternals({
        projectDir: setup.projectDir,
        repoRoot: setup.root,
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
