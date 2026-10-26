import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import type { NativeLoad } from '../src/native-loads.ts';
import { NodeAliasCompatibility } from '../src/node-alias-compatibility.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';
import { nodeModuleAliases } from '../src/node-module-aliases.ts';
import { nodePhysicalLayout } from '../src/node-physical-layout.ts';

async function staged(physical: NodePhysicalFiles, root: string): Promise<void> {
  for (const file of physical.files) {
    const target = path.join(root, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  for (const link of physical.links) {
    const target = path.join(root, link.path);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.relative(path.dirname(target), path.join(root, link.target)), target);
  }
}

describe('closed aliases from environment-pruned layout hints', () => {
  type Mode =
    | 'relative'
    | 'package'
    | 'export-subpath'
    | 'import-only'
    | '#relative'
    | '#external'
    | 'self';

  let directory: string;
  let repository: string;
  let project: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-alternative-alias-'));
    directory = await realpath(temporary);
    repository = path.join(directory, 'repository');
    project = path.join(repository, 'app');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await mkdir(path.join(project, 'build'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(entry: string, files: readonly string[]): BuildFunctionInput {
    return {
      repoRoot: repository,
      projectDir: project,
      patch: { distDir: path.join(project, '.next') },
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [
        { id: '/native', assets: Object.fromEntries(files.map((file) => [file, file])) },
      ],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;
  }

  async function packageFixture(mode: Mode, esm: boolean) {
    const root = path.join(repository, 'store/native-helper');
    await mkdir(path.join(root, 'build'), { recursive: true });
    const target = path.join(root, 'build', esm ? 'target.mjs' : 'target.cjs');
    const alias = path.join(root, esm ? 'alias.mjs' : 'alias.cjs');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'native-helper',
        exports: esm
          ? { import: './alias.mjs' }
          : { '.': './alias.cjs', './native': './alias.cjs' },
      }),
    );
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await symlink(root, path.join(project, 'node_modules/native-helper'));
    return {
      target,
      alias,
      specifier: mode === 'export-subpath' ? 'native-helper/native' : 'native-helper',
    };
  }

  async function fixture(mode: Mode = 'relative') {
    const esm = mode === 'import-only';
    const entry = path.join(project, 'src', esm ? 'entry.mjs' : 'entry.cjs');
    const mutator = path.join(project, 'src/mutator.cjs');
    // Inert authored source only: no test imports, requires or evaluates this mutator.
    await writeFile(mutator, "process.env.NODE_ENV='development';module.exports=42;");
    let target = path.join(project, 'build/target.cjs');
    let alias = path.join(project, 'src/alias.cjs');
    let specifier = './alias.cjs';
    if (['#external', 'export-subpath', 'import-only', 'package'].includes(mode)) {
      ({ target, alias, specifier } = await packageFixture(mode, esm));
    }
    if (mode === '#relative' || mode === '#external') {
      const mapping = mode === '#relative' ? './src/alias.cjs' : specifier;
      await writeFile(
        path.join(project, 'package.json'),
        JSON.stringify({ imports: { '#native': mapping } }),
      );
      specifier = '#native';
    } else if (mode === 'self') {
      await writeFile(
        path.join(project, 'package.json'),
        JSON.stringify({ name: 'self-helper', exports: './src/alias.cjs' }),
      );
      specifier = 'self-helper';
    }
    await writeFile(target, esm ? 'export default 42;' : 'module.exports=42;');
    await symlink(path.relative(path.dirname(alias), target), alias);
    const code = esm
      ? `import './mutator.cjs';export const load=()=>process.env.NODE_ENV!=='production'?import(${JSON.stringify(specifier)}):42;`
      : `require('./mutator.cjs');if(process.env.NODE_ENV!=='production')module.exports=require(${JSON.stringify(specifier)});`;
    await writeFile(entry, code);
    return {
      entry,
      target,
      alias,
      specifier,
      mutator,
      code,
      build: input(entry, [entry, mutator, target]),
    };
  }

  async function hierarchyFixture(mode: 'parent' | 'child' | 'compatible') {
    const entry = path.join(project, 'src/entry.cjs');
    const store = path.join(project, 'store');
    const logical = path.join(project, 'src/links');
    const metadata = path.join(store, 'package.json');
    const target = path.join(project, 'build/target.cjs');
    const index = path.join(store, 'index.cjs');
    const child = path.join(store, 'foo.cjs');
    await mkdir(store);
    await writeFile(target, 'module.exports=42;');
    await writeFile(index, 'module.exports=7;');
    await writeFile(
      metadata,
      JSON.stringify({ main: mode === 'parent' ? 'foo.cjs' : 'index.cjs' }),
    );
    await symlink(path.relative(path.dirname(logical), store), logical);
    if (mode === 'compatible') await writeFile(child, 'module.exports=43;');
    else await symlink(path.relative(store, target), child);
    const required = mode === 'child' ? './links' : './links/foo.cjs';
    const alternative = mode === 'child' ? './links/foo.cjs' : './links';
    const code = `require(${JSON.stringify(required)});if(process.env.NODE_ENV!=='production')require(${JSON.stringify(alternative)});`;
    await writeFile(entry, code);
    const files = [entry, target, index, metadata];
    if (mode === 'compatible') files.push(child);
    const targets = { parent: target, child: index, compatible: child };
    return {
      entry,
      store,
      logical,
      target: targets[mode],
      required,
      code,
      build: input(entry, files),
    };
  }

  async function requiredLayoutFixture(kind: 'trace' | 'native') {
    const entry = path.join(project, 'src/entry.cjs');
    const store = path.join(project, 'store');
    const logical = path.join(project, 'src/links');
    const suffix = kind === 'native' ? '.node' : '.bin';
    const target = path.join(project, 'build', `target${suffix}`);
    const alias = path.join(logical, `asset${suffix}`);
    const index = path.join(store, 'index.cjs');
    const metadata = path.join(store, 'package.json');
    const bytes = Buffer.from('inert authored payload, never loaded');
    const code = "if(process.env.NODE_ENV!=='production')require('./links');module.exports=42;";
    await mkdir(store);
    await writeFile(target, bytes);
    await writeFile(index, 'module.exports=7;');
    await writeFile(metadata, JSON.stringify({ main: 'index.cjs' }));
    await writeFile(entry, code);
    await symlink(path.relative(path.dirname(logical), store), logical);
    await symlink(path.relative(store, target), path.join(store, `asset${suffix}`));
    const build = input(entry, [entry, target, index, metadata]);
    const loads: readonly NativeLoad[] =
      kind === 'native'
        ? [
            {
              kind: 'dlopen',
              importer: entry,
              binary: target,
              binaryAlias: alias,
              owners: ['/native'],
            },
          ]
        : [];
    const assets = { [path.relative(repository, alias)]: target };
    const traces = kind === 'trace' ? [{ id: '/native', assets }] : [];
    return {
      alias,
      target,
      entry,
      logical,
      bytes,
      code,
      loads,
      build: { ...build, entryTraces: [...(build.entryTraces ?? []), ...traces] },
    };
  }

  it.each([
    ['parent', false],
    ['child', true],
    ['compatible', true],
  ] as const)(
    'preserves required resolution when the alternative is a %s hierarchy',
    async (mode, expectedParent) => {
      const own = await hierarchyFixture(mode);
      const physical = await nodePhysicalFiles(own.build, []);
      const archive = path.join(directory, 'archive');
      await staged(physical, archive);
      const archivedEntry = path.join(archive, physical.nameOf(own.entry));
      const resolved = createRequire(archivedEntry).resolve(own.required);
      const parent = { path: physical.nameOf(own.logical), target: physical.nameOf(own.store) };
      const rawLinks = new Map<string, string>();
      const layout = await nodePhysicalLayout(own.build);
      const sources = {
        files: new Map(physical.files.map((file) => [file.name, file.bytes])),
        originals: new Map([...physical.sourcePaths].map(([name, file]) => [file, name])),
      };
      await nodeModuleAliases(sources, layout, rawLinks);
      const childName = layout.nameOf(path.join(own.logical, 'foo.cjs'));

      expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
      await expect(readFile(archivedEntry, 'utf8')).resolves.toBe(own.code);

      expect(
        physical.links.some((link) => link.path === parent.path && link.target === parent.target),
      ).toBe(expectedParent);
      expect(rawLinks.has(childName)).toBe(mode !== 'child');
    },
  );

  it.each<Mode>(['relative', 'package', 'export-subpath', '#relative', '#external', 'self'])(
    'restores an already traced %s alias despite the inert separate-module env write',
    async (mode) => {
      const own = await fixture(mode);
      const physical = await nodePhysicalFiles(own.build, []);
      const archive = path.join(directory, 'archive');
      await staged(physical, archive);
      const archivedAlias = path.join(archive, physical.nameOf(own.alias));
      const archivedEntry = path.join(archive, physical.nameOf(own.entry));
      const resolved = createRequire(archivedEntry).resolve(own.specifier);

      await expect(realpath(archivedAlias)).resolves.toBe(
        path.join(archive, physical.nameOf(own.target)),
      );
      expect(physical.sourcePaths.size).toBe(3);
      await expect(readFile(own.entry, 'utf8')).resolves.toBe(own.code);
      await expect(readFile(archivedEntry, 'utf8')).resolves.toBe(own.code);

      expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
    },
  );

  it.each(['trace', 'native'] as const)(
    'keeps a required %s-only child alias ahead of an optional parent',
    async (kind) => {
      const own = await requiredLayoutFixture(kind);
      const physical = await nodePhysicalFiles(own.build, own.loads);
      const archive = path.join(directory, 'archive');
      await staged(physical, archive);
      const archivedAlias = path.join(archive, physical.nameOf(own.alias));
      const archivedEntry = path.join(archive, physical.nameOf(own.entry));

      expect(physical.links).toContainEqual({
        path: physical.nameOf(own.alias),
        target: physical.nameOf(own.target),
      });
      expect(physical.links.some((link) => link.path === physical.nameOf(own.logical))).toBe(false);
      await expect(readFile(archivedAlias)).resolves.toStrictEqual(own.bytes);
      await expect(readFile(archivedEntry, 'utf8')).resolves.toBe(own.code);
      await expect(readFile(own.target)).resolves.toStrictEqual(own.bytes);
      await expect(readFile(own.entry, 'utf8')).resolves.toBe(own.code);
    },
  );

  it('refuses a required directory parent that would hide a required trace-only binary child', async () => {
    const own = await requiredLayoutFixture('trace');
    await writeFile(
      own.entry,
      "require('./links');if(process.env.NODE_ENV!=='production')require('./missing');",
    );

    await expect(nodePhysicalFiles(own.build, [])).rejects.toThrow(
      'required aliases have incompatible topology',
    );
  });

  it.each([false, true])(
    'rejects incompatible required hierarchy in either insertion order: %s',
    (reverse) => {
      const entries: [string, string][] = [
        ['project/links', 'project/store'],
        ['project/links/asset.bin', 'project/build/target.bin'],
      ];
      const links = new Map(reverse ? entries.toReversed() : entries);

      expect(() => new NodeAliasCompatibility(links)).toThrow(AuditError);
      expect(() => new NodeAliasCompatibility(links)).toThrow(
        'required aliases have incompatible topology',
      );
    },
  );

  it('preserves mutually compatible required parent and child lookups', async () => {
    const own = await hierarchyFixture('compatible');
    await writeFile(own.entry, "require('./links/foo.cjs');require('./links');");
    const physical = await nodePhysicalFiles(own.build, []);
    const archive = path.join(directory, 'required-archive');
    await staged(physical, archive);
    const archivedEntry = path.join(archive, physical.nameOf(own.entry));
    const index = path.join(own.store, 'index.cjs');
    const archivedIndex = path.join(archive, physical.nameOf(index));

    expect(createRequire(archivedEntry).resolve('./links/foo.cjs')).toBe(
      path.join(archive, physical.nameOf(own.target)),
    );
    expect(createRequire(archivedEntry).resolve('./links')).toBe(archivedIndex);
  });

  it('rejects a contradictory required map before entering the optional hint resolver', async () => {
    const own = await fixture();
    const code = "if(process.env.NODE_ENV!=='production')require('./alias.cjs');";
    const layout = await nodePhysicalLayout(own.build);
    const sources = {
      files: new Map([['entry', new TextEncoder().encode(code)]]),
      originals: new Map([[own.entry, 'entry']]),
    };
    const links = new Map<string, string>();
    const nameOf = vi.fn(layout.nameOf);

    await expect(
      nodeModuleAliases(sources, { ...layout, nameOf }, links, () => {
        links.set('project/links/asset.bin', 'project/build/target.bin');
        links.set('project/links', 'project/store');
        return Promise.resolve();
      }),
    ).rejects.toThrow('required aliases have incompatible topology');
    expect(nameOf).not.toHaveBeenCalled();
  });

  it('retains import-only package root and internal aliases without choosing require conditions', async () => {
    const own = await fixture('import-only');
    const physical = await nodePhysicalFiles(own.build, []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const archivedAlias = path.join(archive, physical.nameOf(own.alias));
    const packageAlias = path.join(project, 'node_modules/native-helper');
    const archivedPackage = path.join(archive, physical.nameOf(packageAlias));
    const packageRoot = path.dirname(own.alias);
    const archivedRoot = path.join(archive, physical.nameOf(packageRoot));

    await expect(realpath(archivedAlias)).resolves.toBe(
      path.join(archive, physical.nameOf(own.target)),
    );
    await expect(realpath(archivedPackage)).resolves.toBe(archivedRoot);
    expect(physical.sourcePaths.size).toBe(3);
  });

  it('keeps installed but untraced development-only code absent and preserves required aliases', async () => {
    const own = await fixture();
    const dependency = path.join(project, 'node_modules/dev-only');
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, 'index.js'), 'module.exports=99;');
    await writeFile(
      own.entry,
      "require('./alias.cjs');if(process.env.NODE_ENV!=='production')require('dev-only');",
    );
    const physical = await nodePhysicalFiles(own.build, []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.alias),
      target: physical.nameOf(own.target),
    });
    expect(physical.files.map((file) => file.name).some((name) => name.includes('dev-only'))).toBe(
      false,
    );
    expect(physical.links.some((link) => link.path.includes('dev-only'))).toBe(false);
  });

  it('adds no code or alias for an existing relative alternative outside the closed trace', async () => {
    const own = await fixture();
    const physical = await nodePhysicalFiles(input(own.entry, [own.entry, own.mutator]), []);

    expect(physical.links).toStrictEqual([]);
    expect(physical.sourcePaths.has(physical.nameOf(own.target))).toBe(false);
  });

  it.each([
    `process.env.NODE_ENV==='production'`,
    'process.env.CUSTOM_MODE',
    `(effect(),process.env.NODE_ENV!=='production')`,
  ])('retains the original closed-target refusal for required condition %s', async (condition) => {
    const own = await fixture();
    await writeFile(own.entry, `if(${condition})require('./alias.cjs');`);

    await expect(nodePhysicalFiles(input(own.entry, [own.entry]), [])).rejects.toThrow(
      'outside its closed trace',
    );
  });

  it('does not skip an unowned first existing package to borrow a farther owned alias', async () => {
    const own = await fixture('package');
    const shadow = path.join(project, 'src/node_modules/native-helper');
    await mkdir(shadow, { recursive: true });
    await writeFile(path.join(shadow, 'index.js'), 'module.exports=99;');
    const physical = await nodePhysicalFiles(own.build, []);

    expect(physical.links).toStrictEqual([]);
    expect(
      physical.files.map((file) => file.name).some((name) => name.includes('src/node_modules')),
    ).toBe(false);
  });

  it('never restores an alias from a primitive-literal dead branch', async () => {
    const own = await fixture();
    await writeFile(own.entry, "if(false)require('./alias.cjs');");
    const physical = await nodePhysicalFiles(own.build, []);

    expect(physical.links).toStrictEqual([]);
  });

  it('never lets an alternative label waive the same specifier required elsewhere', async () => {
    const own = await fixture();
    await writeFile(
      own.entry,
      "if(process.env.NODE_ENV!=='production')require('./alias.cjs');require('./alias.cjs');",
    );

    await expect(nodePhysicalFiles(input(own.entry, [own.entry]), [])).rejects.toThrow(
      'outside its closed trace',
    );
  });

  it.each([
    new Error('unexpected alias programming failure'),
    new AuditError('unrelated audit failure'),
    Object.assign(new Error('unexpected IO failure'), { code: 'EIO' }),
  ])('rethrows an unexpected alternative resolver failure', async (failure) => {
    const own = await fixture();
    const layout = await nodePhysicalLayout(own.build);
    const code = "if(process.env.NODE_ENV!=='production')require('./alias.cjs');";
    await writeFile(own.entry, code);
    const sources = {
      files: new Map([['entry', new TextEncoder().encode(code)]]),
      originals: new Map([[own.entry, 'entry']]),
    };
    const rejecting = {
      ...layout,
      nameOf() {
        throw failure;
      },
    };

    await expect(nodeModuleAliases(sources, rejecting, new Map())).rejects.toBe(failure);
  });

  it.each([
    new AuditError('A relative Node module lookup has no proved physical alias'),
    Object.assign(new Error('required alias collection failed'), { code: 'ENOENT' }),
  ])('never treats a required alias collection failure as an optional hint', async (failure) => {
    const own = await fixture();
    const layout = await nodePhysicalLayout(own.build);
    const sources = { files: new Map<string, Uint8Array>(), originals: new Map<string, string>() };

    await expect(
      nodeModuleAliases(sources, layout, new Map(), () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });
});
