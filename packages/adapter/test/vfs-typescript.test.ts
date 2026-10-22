import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

  it("follows a held package's own dependencies, each version where its dependent finds it", async () => {
    const root = await repository();
    const react = await storedPackage(
      root,
      '@types+react@19.2.2',
      { name: '@types/react' },
      { 'index.d.ts': "export type { Property } from 'csstype';\n" },
    );
    const css = await storedPackage(
      root,
      'csstype@3.1.3',
      { name: 'csstype' },
      { 'index.d.ts': 'export declare const version: "3.1.3";\n' },
    );
    const dom = await storedPackage(
      root,
      '@types+react-dom@18.3.7_@types+react@18.3.26',
      { name: '@types/react-dom' },
      { 'index.d.ts': "export type { Property } from 'react';\n" },
    );
    const older = await storedPackage(
      root,
      '@types+react@18.3.26',
      { name: '@types/react' },
      {
        'index.d.ts':
          "export type { Property } from 'csstype';\nexport type * from 'prop-types';\n",
      },
    );
    const olderCss = await storedPackage(
      root,
      'csstype@3.1.2',
      { name: 'csstype' },
      { 'index.d.ts': 'export declare const version: "3.1.2";\n' },
    );
    const props = await storedPackage(
      root,
      '@types+prop-types@15.7.15',
      { name: '@types/prop-types' },
      { 'index.d.ts': 'export declare const checked: true;\n' },
    );
    // `@types/react-dom` 18 has pnpm's `@types/react` 18 beside it, which has `csstype` 3.1.2 and
    // `@types/prop-types` beside it in turn: what the project's own `@types/react` 19 has neither.
    const assets = await pnpmTrace(root, [
      [path.join(root, 'node_modules', '@types', 'react'), react],
      [path.join(root, 'node_modules', '@types', 'react-dom'), dom],
      [path.join(react, '..', '..', 'csstype'), css],
      [path.join(dom, '..', 'react'), older],
      [path.join(older, '..', '..', 'csstype'), olderCss],
      [path.join(older, '..', 'prop-types'), props],
    ]);
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));
    const system = await functionSystem(files);
    const nested = '/bundle/node_modules/@types/react-dom/node_modules/@types/react/index.d.ts';
    const resolved = (name: string, from: string) =>
      resolveModuleName(name, from, RESOLUTION, system).resolvedModule?.resolvedFileName;

    expect(resolved('react', '/bundle/node_modules/@types/react-dom/index.d.ts')).toBe(nested);
    expect(resolved('csstype', nested)).toBe(
      '/bundle/node_modules/@types/react-dom/node_modules/@types/react/node_modules/csstype/index.d.ts',
    );
    expect(resolved('prop-types', nested)).toBe(
      '/bundle/node_modules/@types/react-dom/node_modules/@types/prop-types/index.d.ts',
    );
    expect(resolved('csstype', '/bundle/node_modules/@types/react/index.d.ts')).toBe(
      '/bundle/node_modules/csstype/index.d.ts',
    );
  });

  it("holds the project's own version of a package a types package depends on another of", async () => {
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
      { 'index.d.ts': 'export interface Dispatcher { readonly version: 7 }\n' },
    );
    const own = await storedPackage(
      root,
      'undici-types@6.21.0',
      { name: 'undici-types' },
      { 'index.d.ts': 'export interface Dispatcher { readonly version: 6 }\n' },
    );
    // The project depends on `undici-types` 6 itself; `@types/node` has 7 beside it in the store.
    const assets = await pnpmTrace(root, [
      [path.join(root, 'node_modules', '@types', 'node'), node],
      [path.join(root, 'node_modules', 'undici-types'), own],
      [path.join(node, '..', '..', 'undici-types'), undici],
    ]);
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));
    const system = await functionSystem(files);
    const resolved = (from: string) =>
      resolveModuleName('undici-types', from, RESOLUTION, system).resolvedModule?.resolvedFileName;

    expect(resolved('/bundle/app/page.ts')).toBe('/bundle/node_modules/undici-types/index.d.ts');
    expect(system.readFile('/bundle/node_modules/undici-types/index.d.ts')).toContain('version: 6');
    expect(resolved('/bundle/node_modules/@types/node/index.d.ts')).toBe(
      '/bundle/node_modules/@types/node/node_modules/undici-types/index.d.ts',
    );
  });

  it('finds the types package an ancestor of a nested app links, from /bundle', async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'group', 'site');
    await mkdir(project, { recursive: true });
    const node = await storedPackage(
      root,
      '@types+node@26.1.0',
      { name: '@types/node' },
      { 'index.d.ts': 'declare var version: 26;\n' },
    );
    // `apps/group` is a workspace package of its own, and the app inherits its `@types/node`.
    const assets = await pnpmTrace(root, [
      [path.join(root, 'apps', 'group', 'node_modules', '@types', 'node'), node],
    ]);
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);
    const system = await functionSystem(files);
    const resolved = resolveTypeReferenceDirective('node', undefined, RESOLUTION, system);

    expect(getAutomaticTypeDirectiveNames(WALKED, system)).toStrictEqual(['node']);
    expect(resolved.resolvedTypeReferenceDirective?.resolvedFileName).toBe(
      '/bundle/node_modules/@types/node/index.d.ts',
    );
    // No declaration beside the app resolves through `apps/group/node_modules`: none goes up there.
    expect(files.map((file) => file.name)).toStrictEqual([
      'node_modules/@types/node/index.d.ts',
      'node_modules/@types/node/package.json',
    ]);
  });

  it("finds a workspace package's own dependency from its declarations, in a nested app", async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'site');
    // A workspace package inside the app, whose declarations import what pnpm linked into its own
    // `node_modules`: the declarations go up under their path from the repository, as every one.
    const ui = path.join(project, 'packages', 'ui');
    await mkdir(ui, { recursive: true });
    await writeFile(path.join(ui, 'index.d.ts'), "export type { Schema } from 'zod';\n");
    const zod = await storedPackage(
      root,
      'zod@3.23.8',
      { name: 'zod', types: 'index.d.ts' },
      { 'index.d.ts': 'export type Schema = { version: 3 };\n' },
    );
    const assets = await pnpmTrace(root, [[path.join(ui, 'node_modules', 'zod'), zod]]);
    assets['apps/site/packages/ui/index.d.ts'] = path.join(ui, 'index.d.ts');
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);
    const system = await functionSystem(files);
    const resolved = resolveModuleName(
      'zod',
      '/bundle/apps/site/packages/ui/index.d.ts',
      RESOLUTION,
      system,
    );

    expect(resolved.resolvedModule?.resolvedFileName).toBe(
      '/bundle/apps/site/packages/ui/node_modules/zod/index.d.ts',
    );
  });

  it("holds none of a workspace root's types package where a nested app links its own it cannot hold", async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'site');
    await mkdir(project, { recursive: true });
    // The app's `@types/react` is an npm alias (`"@types/react": "npm:types-react@…"`), which keeps
    // its stored name; the workspace root's is a real `@types/react`, which the app never sees.
    const alias = await storedPackage(
      root,
      'types-react@19.0.0',
      { name: 'types-react' },
      { 'index.d.ts': 'declare var version: 19;\n' },
    );
    const workspace = await storedPackage(
      root,
      '@types+react@18.3.26',
      { name: '@types/react' },
      { 'index.d.ts': 'declare var version: 18;\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(project, 'node_modules', '@types', 'react'), alias],
      [path.join(root, 'node_modules', '@types', 'react'), workspace],
    ]);
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);
    const system = await functionSystem(files);

    expect(files.map((file) => file.name)).toStrictEqual([
      'node_modules/.pnpm/@types+react@18.3.26/node_modules/@types/react/index.d.ts',
      'node_modules/.pnpm/types-react@19.0.0/node_modules/types-react/index.d.ts',
    ]);
    expect(getAutomaticTypeDirectiveNames(WALKED, system)).toStrictEqual([]);
  });

  it.each([path.join('node_modules', '.store'), '.pnpm'])(
    "resolves a linked types package's dependency where pnpm's virtualStoreDir is %s",
    async (store) => {
      const root = await repository();
      const stored = await storedPackage(
        root,
        '@types+node@26.1.0',
        { name: '@types/node' },
        { 'index.d.ts': "export type { Dispatcher } from 'undici-types';\n" },
      );
      await storedPackage(
        root,
        'undici-types@7.16.0',
        { name: 'undici-types' },
        { 'index.d.ts': 'export interface Dispatcher {}\n' },
      );
      // The store where `virtualStoreDir` puts it, rather than at `node_modules/.pnpm`.
      const defaultStore = path.join(root, 'node_modules', '.pnpm');
      await mkdir(path.dirname(path.join(root, store)), { recursive: true });
      await rename(defaultStore, path.join(root, store));
      const node = path.join(root, store, path.relative(defaultStore, stored));
      const undici = path.join(root, store, 'undici-types@7.16.0', 'node_modules', 'undici-types');
      const assets = await pnpmTrace(root, [
        [path.join(root, 'node_modules', '@types', 'node'), node],
        [path.join(node, '..', '..', 'undici-types'), undici],
      ]);
      const files = tracedFiles([{ assets }], root, path.join(root, '.next'));

      expect(files.map((file) => file.name)).toStrictEqual([
        'node_modules/@types/node/index.d.ts',
        'node_modules/@types/node/package.json',
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
    },
  );

  it("resolves a linked workspace package's own dependency from the name the project links it by", async () => {
    const root = await repository();
    // `node_modules/@acme/ui` links the workspace package `packages/ui`, whose own dependency pnpm
    // links into `packages/ui/node_modules`, beside none of the project's.
    const ui = path.join(root, 'packages', 'ui');
    await mkdir(ui, { recursive: true });
    await writeFile(path.join(ui, 'package.json'), JSON.stringify({ name: '@acme/ui' }));
    await writeFile(path.join(ui, 'index.d.ts'), "export type { Schema } from 'zod';\n");
    const zod = await storedPackage(
      root,
      'zod@3.23.8',
      { name: 'zod', types: 'index.d.ts' },
      { 'index.d.ts': 'export type Schema = { version: 3 };\n' },
    );
    const link = path.join(root, 'node_modules', '@acme', 'ui');
    const own = path.join(ui, 'node_modules', 'zod');
    for (const [at, target] of [
      [link, ui],
      [own, zod],
    ] as const) {
      await mkdir(path.dirname(at), { recursive: true });
      await symlink(target, at, 'dir');
    }
    const assets = {
      'node_modules/@acme/ui': link,
      'packages/ui/index.d.ts': path.join(ui, 'index.d.ts'),
      'packages/ui/node_modules/zod': own,
      'node_modules/.pnpm/zod@3.23.8/node_modules/zod/index.d.ts': path.join(zod, 'index.d.ts'),
      'node_modules/.pnpm/zod@3.23.8/node_modules/zod/package.json': path.join(zod, 'package.json'),
    };
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));
    const system = await functionSystem(files);
    const resolved = (from: string) =>
      resolveModuleName('zod', from, RESOLUTION, system).resolvedModule?.resolvedFileName;

    expect(resolved('/bundle/node_modules/@acme/ui/index.d.ts')).toBe(
      '/bundle/node_modules/zod/index.d.ts',
    );
    expect(resolved('/bundle/packages/ui/index.d.ts')).toBe(
      '/bundle/packages/ui/node_modules/zod/index.d.ts',
    );
  });

  it("resolves a dependency pnpm hoisted into its store's own node_modules, beside none", async () => {
    const root = await repository();
    // `@types/plugin` imports `tapable` without depending on it, and finds the one pnpm hoists into
    // `node_modules/.pnpm/node_modules`, which the store's packages look in after their own.
    const plugin = await storedPackage(
      root,
      '@types+plugin@1.0.0',
      { name: '@types/plugin' },
      { 'index.d.ts': "export type { Hook } from 'tapable';\n" },
    );
    const tapable = await storedPackage(
      root,
      'tapable@2.2.1',
      { name: 'tapable', types: 'index.d.ts' },
      { 'index.d.ts': 'export interface Hook {}\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(root, 'node_modules', '@types', 'plugin'), plugin],
      [path.join(root, 'node_modules', '.pnpm', 'node_modules', 'tapable'), tapable],
    ]);
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));
    const system = await functionSystem(files);
    const resolved = resolveModuleName(
      'tapable',
      '/bundle/node_modules/@types/plugin/index.d.ts',
      RESOLUTION,
      system,
    );

    expect(resolved.resolvedModule?.resolvedFileName).toBe(
      '/bundle/node_modules/tapable/index.d.ts',
    );
  });

  it("resolves a workspace's shared declarations against its own links, beside a nested app's", async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'group', 'site');
    await mkdir(project, { recursive: true });
    // `apps/group` is a workspace package with `zod` 3; the app beside its shared declarations has
    // `zod` 4 of its own. Each declaration resolves from where it is.
    const shared = path.join(root, 'apps', 'group', 'shared', 'index.d.ts');
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, "export type { Schema } from 'zod';\n");
    const older = await storedPackage(
      root,
      'zod@3.23.8',
      { name: 'zod', types: 'index.d.ts' },
      { 'index.d.ts': 'export type Schema = { version: 3 };\n' },
    );
    const own = await storedPackage(
      root,
      'zod@4.0.0',
      { name: 'zod', types: 'index.d.ts' },
      { 'index.d.ts': 'export type Schema = { version: 4 };\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(project, 'node_modules', 'zod'), own],
      [path.join(root, 'apps', 'group', 'node_modules', 'zod'), older],
    ]);
    assets['apps/group/shared/index.d.ts'] = shared;
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);
    const system = await functionSystem(files);
    const resolved = (from: string) =>
      resolveModuleName('zod', from, RESOLUTION, system).resolvedModule?.resolvedFileName;

    expect(resolved('/bundle/apps/group/shared/index.d.ts')).toBe(
      '/bundle/apps/group/node_modules/zod/index.d.ts',
    );
    expect(system.readFile('/bundle/apps/group/node_modules/zod/index.d.ts')).toContain('3');
    expect(resolved('/bundle/app/page.ts')).toBe('/bundle/node_modules/zod/index.d.ts');
    expect(system.readFile('/bundle/node_modules/zod/index.d.ts')).toContain('4');
  });

  it('resolves what a linked workspace package takes from the repository root, where the app has its own', async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'site');
    await mkdir(project, { recursive: true });
    // `packages/ui` takes `zod` 3 from the repository root (pnpm's `dedupe-direct-deps` links none
    // into its own `node_modules`); the app that links it has `zod` 4 of its own.
    const ui = path.join(root, 'packages', 'ui');
    await mkdir(ui, { recursive: true });
    await writeFile(path.join(ui, 'package.json'), JSON.stringify({ name: '@acme/ui' }));
    await writeFile(path.join(ui, 'index.d.ts'), "export type { Schema } from 'zod';\n");
    const older = await storedPackage(
      root,
      'zod@3.23.8',
      { name: 'zod', types: 'index.d.ts' },
      { 'index.d.ts': 'export type Schema = { version: 3 };\n' },
    );
    const own = await storedPackage(
      root,
      'zod@4.0.0',
      { name: 'zod', types: 'index.d.ts' },
      { 'index.d.ts': 'export type Schema = { version: 4 };\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(project, 'node_modules', 'zod'), own],
      [path.join(root, 'node_modules', 'zod'), older],
    ]);
    const link = path.join(project, 'node_modules', '@acme', 'ui');
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(ui, link, 'dir');
    assets['apps/site/node_modules/@acme/ui'] = link;
    assets['packages/ui/index.d.ts'] = path.join(ui, 'index.d.ts');
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);
    const system = await functionSystem(files);
    const resolved = (from: string) =>
      resolveModuleName('zod', from, RESOLUTION, system).resolvedModule?.resolvedFileName;
    const fromUi = resolved('/bundle/node_modules/@acme/ui/index.d.ts');

    expect(fromUi).toBe('/bundle/node_modules/@acme/ui/node_modules/zod/index.d.ts');
    expect(system.readFile(fromUi!)).toContain('version: 3');
    expect(resolved('/bundle/app/page.ts')).toBe('/bundle/node_modules/zod/index.d.ts');
    expect(system.readFile('/bundle/node_modules/zod/index.d.ts')).toContain('version: 4');
  });

  it('resolves what a stored package takes from the repository root, where the app has its own', async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'site');
    await mkdir(project, { recursive: true });
    // `@types/plugin` imports `tapable` without depending on it, and with nothing hoisted in pnpm's
    // store (`hoist=false`) finds the repository root's 1; the app has 2 of its own.
    const plugin = await storedPackage(
      root,
      '@types+plugin@1.0.0',
      { name: '@types/plugin' },
      { 'index.d.ts': "export type { Hook } from 'tapable';\n" },
    );
    const older = await storedPackage(
      root,
      'tapable@1.1.3',
      { name: 'tapable', types: 'index.d.ts' },
      { 'index.d.ts': 'export interface Hook { readonly version: 1 }\n' },
    );
    const own = await storedPackage(
      root,
      'tapable@2.2.1',
      { name: 'tapable', types: 'index.d.ts' },
      { 'index.d.ts': 'export interface Hook { readonly version: 2 }\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(project, 'node_modules', '@types', 'plugin'), plugin],
      [path.join(project, 'node_modules', 'tapable'), own],
      [path.join(root, 'node_modules', 'tapable'), older],
    ]);
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);
    const system = await functionSystem(files);
    const resolved = (from: string) =>
      resolveModuleName('tapable', from, RESOLUTION, system).resolvedModule?.resolvedFileName;
    const fromPlugin = resolved('/bundle/node_modules/@types/plugin/index.d.ts');

    expect(fromPlugin).toBe('/bundle/node_modules/@types/plugin/node_modules/tapable/index.d.ts');
    expect(system.readFile(fromPlugin!)).toContain('version: 1');
    expect(resolved('/bundle/app/page.ts')).toBe('/bundle/node_modules/tapable/index.d.ts');
  });

  it('holds nothing more where a package finds what the project does, or first finds what is untraced', async () => {
    const root = await repository();
    const project = path.join(root, 'apps', 'site');
    await mkdir(project, { recursive: true });
    // `@types/plugin` imports `tapable` and `csstype`. pnpm hoists `tapable` 2 into its store's own
    // `node_modules`, untraced, which the package meets before the repository root's 1; `csstype`
    // only the repository root has, which the app finds as well.
    const plugin = await storedPackage(
      root,
      '@types+plugin@1.0.0',
      { name: '@types/plugin' },
      { 'index.d.ts': "export type { Hook } from 'tapable';\nexport type * from 'csstype';\n" },
    );
    const older = await storedPackage(
      root,
      'tapable@1.1.3',
      { name: 'tapable', types: 'index.d.ts' },
      { 'index.d.ts': 'export interface Hook { readonly version: 1 }\n' },
    );
    const own = await storedPackage(
      root,
      'tapable@2.2.1',
      { name: 'tapable', types: 'index.d.ts' },
      { 'index.d.ts': 'export interface Hook { readonly version: 2 }\n' },
    );
    const css = await storedPackage(
      root,
      'csstype@3.1.3',
      { name: 'csstype', types: 'index.d.ts' },
      { 'index.d.ts': 'export interface Properties {}\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(project, 'node_modules', '@types', 'plugin'), plugin],
      [path.join(project, 'node_modules', 'tapable'), own],
      [path.join(root, 'node_modules', 'tapable'), older],
      [path.join(root, 'node_modules', 'csstype'), css],
    ]);
    const hoisted = path.join(root, 'node_modules', '.pnpm', 'node_modules', 'tapable');
    await mkdir(path.dirname(hoisted), { recursive: true });
    await symlink(own, hoisted, 'dir');
    const files = tracedFiles([{ assets }], project, path.join(project, '.next'), root);

    expect(files.map((file) => file.name)).toStrictEqual([
      'node_modules/.pnpm/tapable@1.1.3/node_modules/tapable/index.d.ts',
      'node_modules/@types/plugin/index.d.ts',
      'node_modules/@types/plugin/package.json',
      'node_modules/csstype/index.d.ts',
      'node_modules/csstype/package.json',
      'node_modules/tapable/index.d.ts',
      'node_modules/tapable/package.json',
    ]);
  });

  it("keeps a package's own path where it sits in a workspace package's node_modules, not pnpm's store", async () => {
    const root = await repository();
    // `node_modules/foo` links a real package in `packages/shared/node_modules`, beside which pnpm
    // links the workspace package's `bar`. `packages/shared/index.d.ts` reaches both from its path.
    const shared = path.join(root, 'packages', 'shared');
    const foo = path.join(shared, 'node_modules', 'foo');
    await mkdir(foo, { recursive: true });
    await writeFile(path.join(shared, 'package.json'), JSON.stringify({ name: 'shared' }));
    await writeFile(
      path.join(shared, 'index.d.ts'),
      "export * from './node_modules/foo/index';\nexport type { Bar } from 'bar';\n",
    );
    await writeFile(path.join(foo, 'package.json'), JSON.stringify({ name: 'foo' }));
    await writeFile(path.join(foo, 'index.d.ts'), 'export declare const foo: true;\n');
    const bar = await storedPackage(
      root,
      'bar@1.0.0',
      { name: 'bar', types: 'index.d.ts' },
      { 'index.d.ts': 'export interface Bar {}\n' },
    );
    const assets = await pnpmTrace(root, [[path.join(shared, 'node_modules', 'bar'), bar]]);
    const link = path.join(root, 'node_modules', 'foo');
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(foo, link, 'dir');
    assets['node_modules/foo'] = link;
    assets['packages/shared/index.d.ts'] = path.join(shared, 'index.d.ts');
    assets['packages/shared/node_modules/foo/index.d.ts'] = path.join(foo, 'index.d.ts');
    assets['packages/shared/node_modules/foo/package.json'] = path.join(foo, 'package.json');
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));
    const system = await functionSystem(files);
    const from = '/bundle/packages/shared/index.d.ts';
    const resolved = (name: string) =>
      resolveModuleName(name, from, RESOLUTION, system).resolvedModule?.resolvedFileName;

    expect(resolved('./node_modules/foo/index')).toBe(
      '/bundle/packages/shared/node_modules/foo/index.d.ts',
    );
    expect(resolved('bar')).toBe('/bundle/packages/shared/node_modules/bar/index.d.ts');
    expect(system.fileExists('/bundle/node_modules/foo/index.d.ts')).toBe(true);
  });

  it('drops the store path of a package in pnpm store directories whatever their ids carry', async () => {
    const root = await repository();
    // A peer suffix, and an id pnpm shortened with a hash, as it does past its length limit.
    const dom = await storedPackage(
      root,
      'react-dom@18.3.1_react@18.3.1',
      { name: 'react-dom' },
      { 'index.d.ts': 'export {};\n' },
    );
    const long = await storedPackage(
      root,
      '@scope+long-name@1.0.0_@babel+core@7.29.7_supports-color@10.2.2_530a2f5f521ab1b421cc7e2766c8b6c7',
      { name: '@scope/long-name' },
      { 'index.d.ts': 'export {};\n' },
    );
    const assets = await pnpmTrace(root, [
      [path.join(root, 'node_modules', 'react-dom'), dom],
      [path.join(root, 'node_modules', '@scope', 'long-name'), long],
    ]);
    const files = tracedFiles([{ assets }], root, path.join(root, '.next'));

    expect(files.map((file) => file.name)).toStrictEqual([
      'node_modules/@scope/long-name/index.d.ts',
      'node_modules/@scope/long-name/package.json',
      'node_modules/react-dom/index.d.ts',
      'node_modules/react-dom/package.json',
    ]);
  });
});
