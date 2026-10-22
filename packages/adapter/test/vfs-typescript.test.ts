import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import {
  getAutomaticTypeDirectiveNames,
  ModuleKind,
  type ModuleResolutionHost,
  ModuleResolutionKind,
  resolveModuleName,
  resolveTypeReferenceDirective,
  versionMajorMinor,
} from 'typescript';
import { afterEach, assert, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { FUNCTION_COMPATIBILITY_DATE, FUNCTION_COMPATIBILITY_FLAGS } from '../src/function.ts';
import { bundleLinkedExternals } from '../src/linked-externals.ts';
import { type TracedFile, tracedFiles } from '../src/traced-files.ts';
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

async function fixture(owner = '@typescript/vfs', nested = false, noPeer = false) {
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
  if (noPeer) await rm(typescript, { recursive: true });
  return { root, projectDir, distDir, importer, declaration, files };
}

const RESOLUTION = { module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler };
/** TypeScript 5's default, which TypeScript 6 leaves out: every package in each `@types` walked. */
const WALKED = { ...RESOLUTION, types: ['*'] };

/** A package as pnpm's store keeps it under `root`, in a `node_modules` directory of its own. */
async function storedPackage(
  root: string,
  id: string,
  manifest: Readonly<Record<string, unknown>> & { readonly name: string },
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = path.join(root, 'node_modules', '.pnpm', id, 'node_modules', manifest.name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), contents);
  }
  return directory;
}

/**
 * Each link made at its path, and a trace through them: every link an entry of its own, and every
 * file of the stored package it leads to under its path in the store.
 */
async function pnpmTrace(
  root: string,
  links: readonly (readonly [link: string, target: string])[],
): Promise<Record<string, string>> {
  const assets: Record<string, string> = {};
  const name = (file: string) => path.relative(root, file).split(path.sep).join('/');
  for (const [link, target] of links) {
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
    assets[name(link)] = link;
    const entries = await readdir(target, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isFile()) assets[name(file)] = file;
    }
  }
  return assets;
}

/** TypeScript's view of what a Function holds: each file at `/bundle/<name>`, its cwd, no links. */
async function functionSystem(files: readonly TracedFile[]): Promise<ModuleResolutionHost> {
  const contents = new Map<string, string>();
  const directories = new Set<string>();
  for (const file of files) {
    const name = `/bundle/${file.name}`;
    contents.set(name, await readFile(file.filePath, 'utf8'));
    for (let at = path.posix.dirname(name); at !== '/'; at = path.posix.dirname(at)) {
      directories.add(at);
    }
  }
  return {
    fileExists: (file) => contents.has(file),
    readFile: (file) => contents.get(file),
    directoryExists: (directory) => directories.has(directory),
    getDirectories: (directory) => {
      const children = [...directories].filter((each) => path.posix.dirname(each) === directory);
      return children.map((each) => path.posix.basename(each));
    },
    realpath: (file) => file,
    getCurrentDirectory: () => '/bundle',
  };
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

  it('keeps explicit VFS libraries usable when the traced fallback is unavailable', () => {
    const rewritten = replaceTypescriptLibDirectory(SOURCE, undefined);
    assert.ok(rewritten !== undefined);

    expect(rewritten.edits).toBe(3);

    const state = { exports: {}, result: undefined as unknown, require: () => path.posix };
    // eslint-disable-next-line sonarjs/code-eval -- only the rewritten fixed module executes in this test.
    runInNewContext(
      `${rewritten.code.toString()}
      result = [exports.directories('/custom/lib'), exports.shadowed({resolve(){return '/local/typescript.js';}})];`,
      state,
    );

    expect(structuredClone(state.result)).toStrictEqual([
      ['/custom/lib', '/custom/lib', '/custom/lib'],
      '/local',
    ]);
    expect(() => {
      // eslint-disable-next-line sonarjs/code-eval -- only the rewritten fixed fallback is evaluated.
      runInNewContext(
        `${rewritten.code.toString()}
        exports.directories(undefined);`,
        state,
      );
    }).toThrow('TypeScript library fallback is unavailable');
    expect(rewritten.code.toString()).not.toContain(DIRECTORY);
  });

  it('keeps a supplied CDN map from evaluating the unavailable Node fallback', () => {
    const source = `const path = require('path');
      exports.map = (supplied) => supplied ?? path.dirname(require.resolve('typescript'));`;
    const rewritten = replaceTypescriptLibDirectory(source, undefined);
    assert.ok(rewritten !== undefined);
    const state = { exports: {}, result: undefined as unknown, require: () => path.posix };
    // eslint-disable-next-line sonarjs/code-eval -- fixed source with a local map and path-only loader.
    runInNewContext(
      `${rewritten.code.toString()}
      result = [exports.map(new Map([['/lib.d.ts', 'interface String {}']])), exports.map('')];`,
      state,
    );

    expect(structuredClone(state.result)).toStrictEqual([
      new Map([['/lib.d.ts', 'interface String {}']]),
      '',
    ]);
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
    await expect(typescriptLibDirectory(setup.importer, setup.root, [])).resolves.toBeUndefined();
  });

  it('leaves the Node fallback unavailable when no TypeScript peer is installed', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    await rm(path.join(setup.root, 'node_modules', 'typescript'), { recursive: true });

    await expect(typescriptLibDirectory(setup.importer, setup.root, [])).resolves.toBeUndefined();
  });

  it('still rejects a package masquerading as the TypeScript peer without a trace', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    await writeFile(
      path.join(setup.root, 'node_modules', 'typescript', 'package.json'),
      '{"name":"not-typescript","main":"lib/typescript.js"}',
    );

    await expect(typescriptLibDirectory(setup.importer, setup.root, [])).rejects.toThrow(
      'unverified TypeScript peer',
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

  it('mounts one library directory from a pnpm trace that also links TypeScript and @types/node', async () => {
    const setup = await fixture('@typescript/vfs', true);
    roots.push(setup.root);
    const modules = path.join(setup.root, 'node_modules');
    const types = path.join(
      modules,
      '.pnpm',
      '@types+node@26.1.0',
      'node_modules',
      '@types',
      'node',
    );
    const typesFile = path.join(types, 'index.d.ts');
    await mkdir(types, { recursive: true });
    await writeFile(path.join(types, 'package.json'), '{"name":"@types/node"}');
    await writeFile(typesFile, '/// <reference lib="es2020" />');
    await mkdir(path.join(modules, '@types'));
    await symlink(types, path.join(modules, '@types', 'node'), 'dir');
    const stored = (file: string) => path.relative(setup.root, file).split(path.sep).join('/');
    // `lib.*.d.ts` and `./node_modules/@types/node/**` traced through pnpm's links: each stored
    // file, and each link on the way to one, the compiler's own among them.
    const assets = {
      [stored(setup.declaration)]: setup.declaration,
      'node_modules/typescript': path.join(modules, 'typescript'),
      [stored(typesFile)]: typesFile,
      'node_modules/@types/node': path.join(modules, '@types', 'node'),
    };
    const files = tracedFiles([{ assets }], setup.projectDir, setup.distDir, setup.root);

    expect(files).toStrictEqual([
      { name: stored(setup.declaration), filePath: setup.declaration },
      { name: 'node_modules/@types/node/index.d.ts', filePath: typesFile },
    ]);
    await expect(
      typescriptLibDirectory(setup.importer, setup.projectDir, files, setup.root),
    ).resolves.toBe(`/bundle/${stored(path.dirname(setup.declaration))}`);
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
    {
      owner: '@typescript/vfs',
      nested: false,
      omitTrace: true,
      explicit: true,
      expected: [['/custom/lib', '/custom/lib', '/custom/lib']],
    },
    {
      owner: '@typescript/vfs',
      nested: false,
      omitTrace: true,
      expected: { name: 'Error' },
    },
    {
      owner: '@typescript/vfs',
      nested: false,
      omitTrace: true,
      noPeer: true,
      explicit: true,
      expected: [['/custom/lib', '/custom/lib', '/custom/lib']],
    },
  ])(
    'checks actual peer identity for $owner in nested project $nested with omitted trace $omitTrace, absent peer $noPeer and explicit libraries $explicit',
    async ({ owner, nested, expected, omitTrace, noPeer, explicit }) => {
      const setup = await fixture(owner, nested, noPeer);
      roots.push(setup.root);
      const linked = await bundleLinkedExternals({
        projectDir: setup.projectDir,
        repoRoot: setup.root,
        files: omitTrace === true ? [] : setup.files,
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
          ${explicit === true ? "result = [exports.directories('/custom/lib')];" : LOCAL_CALLS}
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

describe('pnpm-linked types packages, as TypeScript finds them in a Function', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function repository(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'upwind-linked-types-'));
    roots.push(root);
    return root;
  }

  it("resolves a linked types package's dependency, which pnpm linked beside it in its store", async () => {
    const root = await repository();
    const node = await storedPackage(
      root,
      '@types+node@26.1.0',
      { name: '@types/node' },
      { 'index.d.ts': "export type { Dispatcher } from 'undici-types';\n" },
    );
    const undici = await storedPackage(
      root,
      'undici-types@7.16.0',
      { name: 'undici-types' },
      { 'index.d.ts': 'export interface Dispatcher {}\n' },
    );
    const ws = await storedPackage(
      root,
      '@types+ws@8.18.1',
      { name: '@types/ws' },
      { 'index.d.ts': '/// <reference types="node" />\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(root, 'node_modules', '@types', 'node'), node],
      [path.join(root, 'node_modules', '@types', 'ws'), ws],
      // Beside each package in its store: `@types/node`'s `undici-types`, and the `@types/node`
      // `@types/ws` depends on, which is the project's own.
      [path.join(node, '..', '..', 'undici-types'), undici],
      [path.join(ws, '..', 'node'), node],
    ]);
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));

    expect(files.map((file) => file.name)).toStrictEqual([
      'node_modules/@types/node/index.d.ts',
      'node_modules/@types/node/package.json',
      'node_modules/@types/ws/index.d.ts',
      'node_modules/@types/ws/package.json',
      'node_modules/undici-types/index.d.ts',
      'node_modules/undici-types/package.json',
    ]);

    const system = await functionSystem(files);
    const resolved = resolveModuleName(
      'undici-types',
      '/bundle/node_modules/@types/node/index.d.ts',
      RESOLUTION,
      system,
    );

    expect(resolved.resolvedModule?.resolvedFileName).toBe(
      '/bundle/node_modules/undici-types/index.d.ts',
    );
  });

  it('holds a dependency in its dependent where the project holds another version of it', async () => {
    const root = await repository();
    const react = await storedPackage(
      root,
      '@types+react@19.2.2',
      { name: '@types/react' },
      { 'index.d.ts': 'export declare const version: 19;\n' },
    );
    const older = await storedPackage(
      root,
      '@types+react@18.3.26',
      { name: '@types/react' },
      { 'index.d.ts': 'export declare const version: 18;\n' },
    );
    const dom = await storedPackage(
      root,
      '@types+react-dom@18.3.7_@types+react@18.3.26',
      { name: '@types/react-dom' },
      { 'index.d.ts': "export { version } from 'react';\n" },
    );
    const assets = await pnpmTrace(root, [
      [path.join(root, 'node_modules', '@types', 'react'), react],
      [path.join(root, 'node_modules', '@types', 'react-dom'), dom],
      [path.join(dom, '..', 'react'), older],
    ]);
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));

    expect(files.map((file) => file.name)).toStrictEqual([
      'node_modules/@types/react-dom/index.d.ts',
      'node_modules/@types/react-dom/node_modules/@types/react/index.d.ts',
      'node_modules/@types/react-dom/node_modules/@types/react/package.json',
      'node_modules/@types/react-dom/package.json',
      'node_modules/@types/react/index.d.ts',
      'node_modules/@types/react/package.json',
    ]);

    const system = await functionSystem(files);
    const fromDom = resolveModuleName(
      'react',
      '/bundle/node_modules/@types/react-dom/index.d.ts',
      RESOLUTION,
      system,
    );
    const fromProject = resolveModuleName('react', '/bundle/app/page.ts', RESOLUTION, system);

    expect(fromDom.resolvedModule?.resolvedFileName).toBe(
      '/bundle/node_modules/@types/react-dom/node_modules/@types/react/index.d.ts',
    );
    expect(fromProject.resolvedModule?.resolvedFileName).toBe(
      '/bundle/node_modules/@types/react/index.d.ts',
    );
  });

  it("takes a linked types package's entry for the compiler in use from its traced manifest", async () => {
    const root = await repository();
    // As `@types/node` sends TypeScript 5.6 to `ts5.6/index.d.ts`, for the compiler running this.
    const compatible = `ts${versionMajorMinor}`;
    const node = await storedPackage(
      root,
      '@types+node@26.1.0',
      {
        name: '@types/node',
        types: 'index.d.ts',
        typesVersions: { [`<=${versionMajorMinor}`]: { '*': [`${compatible}/*`] } },
      },
      {
        'index.d.ts': 'declare var entry: "latest";\n',
        [`${compatible}/index.d.ts`]: 'declare var entry: "compatible";\n',
      },
    );
    const assets = await pnpmTrace(root, [
      [path.join(root, 'node_modules', '@types', 'node'), node],
    ]);
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));
    const system = await functionSystem(files);
    const resolved = resolveTypeReferenceDirective('node', undefined, RESOLUTION, system);

    expect(resolved.resolvedTypeReferenceDirective?.resolvedFileName).toBe(
      `/bundle/node_modules/@types/node/${compatible}/index.d.ts`,
    );
  });

  it('finds first the types package a nested app links in its own node_modules, from /bundle', async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'site');
    await mkdir(project, { recursive: true });
    const own = await storedPackage(
      root,
      '@types+node@26.1.0',
      { name: '@types/node' },
      { 'index.d.ts': 'declare var version: 26;\n' },
    );
    const workspace = await storedPackage(
      root,
      '@types+node@24.19.2',
      { name: '@types/node' },
      { 'index.d.ts': 'declare var version: 24;\n' },
    );
    // The app's own link, and the workspace root's, which the app would find only after its own.
    const assets = await pnpmTrace(root, [
      [path.join(project, 'node_modules', '@types', 'node'), own],
      [path.join(root, 'node_modules', '@types', 'node'), workspace],
    ]);
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);

    expect(files.map((file) => file.name)).toStrictEqual([
      'node_modules/.pnpm/@types+node@24.19.2/node_modules/@types/node/index.d.ts',
      'node_modules/@types/node/index.d.ts',
      'node_modules/@types/node/package.json',
    ]);

    const system = await functionSystem(files);
    const resolved = resolveTypeReferenceDirective('node', undefined, RESOLUTION, system);
    const entry = resolved.resolvedTypeReferenceDirective?.resolvedFileName;

    expect(getAutomaticTypeDirectiveNames(WALKED, system)).toStrictEqual(['node']);
    expect(entry).toBe('/bundle/node_modules/@types/node/index.d.ts');
    expect(system.readFile(entry!)).toBe('declare var version: 26;\n');
  });
});
