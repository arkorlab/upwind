import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';

import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { NodeArtifactFiles } from '../src/node-artifact-files.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import { nodeSourceMaps } from '../src/node-source-maps.ts';

describe('native physical module relocation', () => {
  let directory: string;
  let repository: string;
  let project: string;
  let output: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-node-topology-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    repository = path.join(directory, 'repository');
    project = path.join(repository, 'app');
    output = path.join(directory, 'output');
    await mkdir(project, { recursive: true });
    await mkdir(path.join(output, 'server'), { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(entry: string, files: readonly string[]): BuildFunctionInput {
    // This closure fixture supplies exactly the fields the physical packager reads; no build runs.
    return {
      repoRoot: repository,
      projectDir: project,
      patch: { distDir: output },
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [
        { id: '/native', assets: Object.fromEntries(files.map((file) => [file, file])) },
      ],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;
  }

  it('preserves an unresolved optional relative lookup beyond the tracing root', async () => {
    const entry = path.join(project, 'entry.cjs');
    await writeFile(entry, "try{require('../../not-present.cjs')}catch{};module.exports=42;");
    const physical = await nodePhysicalFiles(input(entry, [entry]), []);

    expect(physical.files.map((file) => file.name)).toContain('project/app/entry.cjs');
  });

  it.each(['repository', 'project', 'both'] as const)(
    'preserves the canonical project namespace through a symlinked %s root',
    async (mode) => {
      const entry = path.join(project, 'entry.cjs');
      await writeFile(entry, 'module.exports=42;');
      const repositoryAlias = path.join(directory, 'repository-link');
      const projectAlias = path.join(directory, 'project-link');
      await symlink(repository, repositoryAlias);
      await symlink(project, projectAlias);
      const build = input(entry, [entry]);
      const projectDir = mode === 'both' ? path.join(repositoryAlias, 'app') : projectAlias;
      const physical = await nodePhysicalFiles(
        {
          ...build,
          repoRoot: mode === 'project' ? repository : repositoryAlias,
          projectDir: mode === 'repository' ? project : projectDir,
        },
        [],
      );

      expect(physical.cwd).toBe('project/app');
      expect(physical.files.map((file) => file.name)).toContain('project/app/entry.cjs');
    },
  );

  it('keeps a canonical external distDir in its reserved namespace through a symlink', async () => {
    const entry = path.join(output, 'server/entry.cjs');
    const chunk = path.join(output, 'server/chunk.cjs');
    await writeFile(entry, "module.exports=require('./chunk.cjs');");
    await writeFile(chunk, 'module.exports=42;');
    const alias = path.join(directory, 'output-link');
    await symlink(output, alias);
    const build = input(entry, [entry, chunk]);
    const physical = await nodePhysicalFiles(
      { ...build, patch: { ...build.patch, distDir: alias } },
      [],
    );

    expect(physical.files.map((file) => file.name)).toStrictEqual(
      expect.arrayContaining([
        'project/app/.upwind-build/server/entry.cjs',
        'project/app/.upwind-build/server/chunk.cjs',
      ]),
    );
  });

  it('preserves root-contained files when an unused distDir does not exist', async () => {
    const entry = path.join(project, 'entry.cjs');
    await writeFile(entry, 'module.exports=42;');
    const build = input(entry, [entry]);
    const physical = await nodePhysicalFiles(
      {
        ...build,
        patch: { ...build.patch, distDir: path.join(directory, 'missing-output') },
      },
      [],
    );

    expect(physical.files.map((file) => file.name)).toContain('project/app/entry.cjs');
  });

  it('grants no outside-root namespace from a nonexistent distDir', async () => {
    const entry = path.join(output, 'server/entry.cjs');
    await writeFile(entry, 'module.exports=42;');
    const build = input(entry, [entry]);

    await expect(
      nodePhysicalFiles(
        {
          ...build,
          patch: { ...build.patch, distDir: path.join(directory, 'missing-output') },
        },
        [],
      ),
    ).rejects.toThrow('escapes both its tracing root and build output');
  });

  it('does not ignore a non-ENOENT distDir error', async () => {
    const entry = path.join(project, 'entry.cjs');
    await writeFile(entry, 'module.exports=42;');
    const build = input(entry, [entry]);

    await expect(
      nodePhysicalFiles(
        {
          ...build,
          patch: { ...build.patch, distDir: path.join(entry, 'not-a-directory') },
        },
        [],
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('rejects a logical project root whose symlink leaves the canonical repository', async () => {
    const outside = path.join(directory, 'outside');
    await mkdir(outside);
    const entry = path.join(outside, 'entry.cjs');
    await writeFile(entry, 'module.exports=42;');
    const alias = path.join(repository, 'outside-link');
    await symlink(outside, alias);
    const build = input(entry, [entry]);

    await expect(nodePhysicalFiles({ ...build, projectDir: alias }, [])).rejects.toThrow(
      'project directory escapes its tracing root',
    );
  });

  it('rejects a source symlink outside both canonical root namespaces', async () => {
    const outside = path.join(directory, 'outside.cjs');
    await writeFile(outside, 'module.exports=42;');
    const entry = path.join(project, 'entry.cjs');
    await symlink(outside, entry);

    await expect(nodePhysicalFiles(input(entry, [entry]), [])).rejects.toThrow(
      'escapes both its tracing root and build output',
    );
  });

  it('normalizes a relocated manifest root using the real Node cwd and path.join semantics', async () => {
    const entry = path.join(output, 'server/entry.cjs');
    await writeFile(entry, 'exports.routeModule={};');
    const build = input(entry, [entry]);
    const physical = await nodePhysicalFiles(build, []);
    const files = new NodeArtifactFiles(build, physical, []);
    await files.addAppEntry();
    const source = files.files.get('upwind/app.cjs');
    assert.isDefined(source, 'missing generated app entry');
    const routeModule = { distDir: 'build-machine-path' };
    const module = {
      exports: { entries: {} as Record<string, () => { routeModule: typeof routeModule }> },
    };
    const modules: Record<string, unknown> = {
      'node:async_hooks': { AsyncLocalStorage },
      [`/bundle/${physical.nameOf(entry)}`]: { routeModule },
    };
    // eslint-disable-next-line sonarjs/code-eval -- Execute only this SDK-generated table with inert authored module objects; never application source or filesystem loaders.
    new Script(new TextDecoder().decode(source.bytes)).runInNewContext({
      module,
      require: (name: string) => modules[name],
    });
    module.exports.entries['/native']!();

    expect(routeModule.distDir).toBe('.upwind-build');
    expect(
      path.posix.join(`/bundle/${physical.cwd}`, routeModule.distDir, 'server/entry.cjs'),
    ).toBe(`/bundle/${physical.nameOf(entry)}`);
  });

  it.each(['comment', 'kept'] as const)(
    'finds a relocated output source map through its original physical path: %s',
    async (mode) => {
      const entry = path.join(output, 'server/entry.cjs');
      const map = path.join(output, 'server/entry.cjs.map');
      const source = JSON.stringify({
        version: 3,
        sources: ['entry.ts'],
        names: [],
        mappings: 'AAAA',
      });
      await writeFile(entry, 'module.exports=42;\n//# sourceMappingURL=entry.cjs.map\n');
      await writeFile(map, source);
      const mapFor = vi.fn(() => ({ seen: true, file: map, origin: map }));
      const outDir = path.join(directory, 'artifacts');
      const blobStore = new BlobStore(outDir);
      await blobStore.init();
      const build: BuildFunctionInput = {
        ...input(entry, [entry]),
        kind: 'app',
        sourceMaps: true,
        outDir,
        blobStore,
        ...(mode === 'kept' && { keptMaps: { mapFor } }),
      };
      const physical = await nodePhysicalFiles(build, []);
      const maps = await nodeSourceMaps(
        build,
        physical,
        new Map(physical.files.map((file) => [file.name, file])),
      );

      expect(maps).toHaveLength(1);
      expect(maps[0]?.name).toBe('app/project/app/.upwind-build/server/entry.cjs');
      await expect(
        readFile(path.join(outDir, 'blobs', maps[0]!.blob.sha256), 'utf8'),
      ).resolves.toBe(source);
      expect(mapFor.mock.calls).toStrictEqual(mode === 'kept' ? [[entry]] : []);
    },
  );

  it.each([
    "module.exports=require('../../repository/app/shared.cjs');\n",
    'module.exports=require(`../../repository/app/shared.cjs`);\n',
    'module.exports=()=>import(`../../repository/app/shared.cjs`);\n',
  ])(
    'refuses an external distDir relative import whose relocation changes its meaning: %s',
    async (source) => {
      const entry = path.join(output, 'server/entry.cjs');
      const target = path.join(project, 'shared.cjs');
      await writeFile(entry, source);
      await writeFile(target, 'module.exports=42;\n');

      await expect(nodePhysicalFiles(input(entry, [entry, target]), [])).rejects.toThrow(
        'relocation changes',
      );
    },
  );

  it('refuses a relative native binary lookup crossing the same relocation boundary', async () => {
    const entry = path.join(output, 'server/entry.cjs');
    const binary = path.join(project, 'addon.node');
    await writeFile(entry, 'module.exports=42;\n');
    await writeFile(binary, new Uint8Array([0, 1]));

    await expect(
      nodePhysicalFiles(input(entry, [entry, binary]), [
        { kind: 'dlopen', importer: entry, binary, owners: ['/native'] },
      ]),
    ).rejects.toThrow('relocation changes');
  });

  it('preserves external output imports wholly inside the output tree', async () => {
    const entry = path.join(output, 'server/entry.cjs');
    const target = path.join(output, 'server/chunk.cjs');
    await writeFile(entry, "module.exports=require('./chunk.cjs');\n");
    await writeFile(target, 'module.exports=42;\n');
    const physical = await nodePhysicalFiles(input(entry, [entry, target]), []);

    expect(physical.files.map((file) => file.name)).toStrictEqual(
      expect.arrayContaining([
        'project/app/.upwind-build/server/entry.cjs',
        'project/app/.upwind-build/server/chunk.cjs',
      ]),
    );
  });

  it('preserves ordinary in-repository relative imports and native dirname relationships', async () => {
    const entry = path.join(project, 'entry.cjs');
    const target = path.join(project, 'shared.cjs');
    const binary = path.join(project, 'addon.node');
    await writeFile(entry, "module.exports=require('./shared.cjs');\n");
    await writeFile(target, 'module.exports=42;\n');
    await writeFile(binary, new Uint8Array([0, 1]));
    const physical = await nodePhysicalFiles(input(entry, [entry, target, binary]), [
      { kind: 'dlopen', importer: entry, binary, owners: ['/native'] },
    ]);

    expect(physical.files.map((file) => file.name)).toStrictEqual(
      expect.arrayContaining([
        'project/app/entry.cjs',
        'project/app/shared.cjs',
        'project/app/addon.node',
      ]),
    );
  });

  it.each([
    "module.exports=require('pkg');\n",
    'module.exports=require(`pkg`);\n',
    'module.exports=()=>import(`pkg`);\n',
  ])('retains a proved bare-package symlink alias: %s', async (source) => {
    const entry = path.join(project, 'entry.cjs');
    const packageRoot = path.join(repository, 'store/pkg');
    const target = path.join(packageRoot, 'index.js');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), '{"name":"pkg","main":"index.js"}\n');
    await writeFile(target, 'module.exports=42;\n');
    await writeFile(entry, source);
    await symlink(packageRoot, path.join(project, 'node_modules/pkg'));
    const physical = await nodePhysicalFiles(input(entry, [entry, target]), []);

    expect(physical.links).toContainEqual({
      path: 'project/app/node_modules/pkg',
      target: 'project/store/pkg',
    });
  });

  it.each([
    { specifier: './addon.node', alias: 'addon.node' },
    { specifier: './addon', alias: 'addon.node' },
  ])(
    'preserves a canonical-only relative binary alias: $specifier',
    async ({ specifier, alias }) => {
      const entry = path.join(project, 'entry.cjs');
      const binary = path.join(project, 'build/Release/addon.node');
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, new Uint8Array([0, 1]));
      await writeFile(entry, `module.exports=require(${JSON.stringify(specifier)});\n`);
      await symlink(binary, path.join(project, alias));
      const physical = await nodePhysicalFiles(input(entry, [entry, binary]), []);

      expect(physical.links).toContainEqual({
        path: `project/app/${alias}`,
        target: 'project/app/build/Release/addon.node',
      });
    },
  );

  it('refuses a relative binary alias whose physical target is absent from the closed trace', async () => {
    const entry = path.join(project, 'entry.cjs');
    const binary = path.join(project, 'untraced.node');
    await writeFile(binary, new Uint8Array([0, 1]));
    await writeFile(entry, "module.exports=require('./addon.node');\n");
    await symlink(binary, path.join(project, 'addon.node'));

    await expect(nodePhysicalFiles(input(entry, [entry]), [])).rejects.toThrow(
      'outside its closed trace',
    );
  });

  it.each([
    { label: 'import-only', exports: { '.': { import: './import.mjs' } } },
    {
      label: 'conditional import/require',
      exports: { '.': { import: './import.mjs', require: './require.cjs' } },
    },
  ])('preserves a canonical-only NFT package alias for $label exports', async (profile) => {
    const entry = path.join(project, 'entry.mjs');
    const packageRoot = path.join(repository, 'store/actual-package');
    const imported = path.join(packageRoot, 'import.mjs');
    const required = path.join(packageRoot, 'require.cjs');
    const metadata = path.join(packageRoot, 'package.json');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await writeFile(
      metadata,
      JSON.stringify({ name: 'actual-package', type: 'module', exports: profile.exports }),
    );
    await writeFile(imported, 'export const value=42;\n');
    await writeFile(required, 'module.exports={value:43};\n');
    await writeFile(entry, "export {value} from 'alias-package';\n");
    await symlink(packageRoot, path.join(project, 'node_modules/alias-package'));
    // NFT has physical paths only; neither a logical alias nor an exported package.json is needed.
    const physical = await nodePhysicalFiles(input(entry, [entry, imported, required]), []);

    expect(physical.links).toContainEqual({
      path: 'project/app/node_modules/alias-package',
      target: 'project/store/actual-package',
    });
    expect(physical.files.map((file) => file.name)).toStrictEqual(
      expect.arrayContaining([
        'project/store/actual-package/import.mjs',
        'project/store/actual-package/require.cjs',
        'project/store/actual-package/package.json',
      ]),
    );
  });

  it('does not skip an existing unowned package for a later traced package', async () => {
    const entry = path.join(project, 'entry.mjs');
    const first = path.join(repository, 'store/unowned');
    const later = path.join(repository, 'store/owned');
    const target = path.join(later, 'index.mjs');
    await mkdir(first, { recursive: true });
    await mkdir(later, { recursive: true });
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await mkdir(path.join(repository, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(first, 'package.json'),
      '{"type":"module","exports":{"import":"./index.mjs"}}\n',
    );
    await writeFile(path.join(first, 'index.mjs'), 'export const value=0;\n');
    await writeFile(
      path.join(later, 'package.json'),
      '{"type":"module","exports":{"import":"./index.mjs"}}\n',
    );
    await writeFile(target, 'export const value=42;\n');
    await writeFile(entry, "export {value} from 'pkg';\n");
    await symlink(first, path.join(project, 'node_modules/pkg'));
    await symlink(later, path.join(repository, 'node_modules/pkg'));

    await expect(nodePhysicalFiles(input(entry, [entry, target]), [])).rejects.toThrow(
      'first existing Node package target is outside its closed trace',
    );
  });

  it('preserves a relative package whose main names a directory index', async () => {
    const entry = path.join(project, 'entry.cjs');
    const metadata = path.join(project, 'pkg/package.json');
    const target = path.join(project, 'pkg/lib/index.js');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(metadata, '{"main":"lib"}');
    await writeFile(target, 'module.exports=42;');
    await writeFile(entry, "module.exports=require('./pkg');");
    const physical = await nodePhysicalFiles(input(entry, [entry, target]), []);

    expect(physical.files.map((file) => file.name)).toContain('project/app/pkg/lib/index.js');
  });

  it.each([
    "if(false)require('./unused.js');",
    "if(true){}else require('./unused.js');",
    "false&&require('./unused.js');",
    "true||require('./unused.js');",
    "const unused=false?require('./unused.js'):0;",
  ])('does not require a physical alias for a statically impossible load: %s', async (dead) => {
    const entry = path.join(project, 'entry.cjs');
    const unused = path.join(project, 'unused.js');
    await writeFile(unused, 'module.exports=42;');
    await writeFile(entry, `module.exports=42;${dead}`);
    const physical = await nodePhysicalFiles(input(entry, [entry]), []);

    expect(physical.files.map((file) => file.name)).not.toContain('project/app/unused.js');
  });
});
