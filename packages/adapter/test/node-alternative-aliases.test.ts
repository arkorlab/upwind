import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';
import { nodeModuleAliases } from '../src/node-module-aliases.ts';
import { nodePhysicalLayout } from '../src/node-physical-layout.ts';

type Mode =
  | 'relative'
  | 'package'
  | 'export-subpath'
  | 'import-only'
  | '#relative'
  | '#external'
  | 'self';

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
    expect(physical.sourcePaths.has(own.target)).toBe(false);
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
});
