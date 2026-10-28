import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';

function input(project: string, entry: string, files: readonly string[]): BuildFunctionInput {
  return {
    repoRoot: path.dirname(project),
    projectDir: project,
    patch: { distDir: path.join(project, '.next') },
    entries: [{ id: '/native', filePath: entry }],
    entryTraces: [{ id: '/native', assets: Object.fromEntries(files.map((file) => [file, file])) }],
    files: [],
    edgeEntries: [],
    manifests: [],
  } as unknown as BuildFunctionInput;
}

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

describe('closed nearest-package self references', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-package-self-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    project = path.join(directory, 'repository/app');
    await mkdir(path.join(project, '.next'), { recursive: true });
    await mkdir(path.join(project, 'src'));
    await mkdir(path.join(project, 'build'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(packageName = 'self-native', subpath = '') {
    const entry = path.join(project, 'src/entry.cjs');
    const target = path.join(project, 'build/addon.cjs');
    const logical = path.join(project, 'addon.cjs');
    const specifier = `${packageName}${subpath}`;
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: packageName,
        exports: { '.': './addon.cjs', './native': './addon.cjs' },
      }),
    );
    await writeFile(target, 'module.exports=42;');
    await symlink('./build/addon.cjs', logical);
    await writeFile(entry, `module.exports=require(${JSON.stringify(specifier)});`);
    return { entry, target, logical, specifier, packageName };
  }

  it.each([
    ['self-native', ''],
    ['self-native', '/native'],
    ['@scope/self-native', ''],
    ['@scope/self-native', '/native'],
  ])('preserves the self export %s%s without a node_modules alias', async (name, subpath) => {
    const own = await fixture(name, subpath);
    const physical = await nodePhysicalFiles(
      input(project, own.entry, [own.entry, own.target]),
      [],
    );
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const resolved = createRequire(path.join(archive, physical.nameOf(own.entry))).resolve(
      own.specifier,
    );

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.target),
    });
    expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
  });

  it('resolves the closed self reference before an unowned installed package with the same name', async () => {
    const own = await fixture();
    const competitor = path.join(project, 'node_modules/self-native');
    await mkdir(competitor, { recursive: true });
    await writeFile(path.join(competitor, 'index.js'), 'module.exports=99;');
    const physical = await nodePhysicalFiles(
      input(project, own.entry, [own.entry, own.target]),
      [],
    );

    expect(physical.links).toStrictEqual([
      { path: physical.nameOf(own.logical), target: physical.nameOf(own.target) },
    ]);
    expect(physical.files.map((file) => file.name)).not.toContain(
      'project/app/node_modules/self-native/index.js',
    );
  });

  it('preserves both closed conditional targets without choosing CommonJS conditions for import', async () => {
    const own = await fixture();
    const imported = path.join(project, 'build/addon.mjs');
    const importedAlias = path.join(project, 'addon.mjs');
    await writeFile(imported, 'export default 43;');
    await symlink('./build/addon.mjs', importedAlias);
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: own.packageName,
        exports: { import: './addon.mjs', require: './addon.cjs' },
      }),
    );
    await writeFile(own.entry, "module.exports=()=>import('self-native');");
    const physical = await nodePhysicalFiles(
      input(project, own.entry, [own.entry, own.target, imported]),
      [],
    );

    expect(physical.links).toStrictEqual(
      expect.arrayContaining([
        { path: physical.nameOf(own.logical), target: physical.nameOf(own.target) },
        { path: physical.nameOf(importedAlias), target: physical.nameOf(imported) },
      ]),
    );
  });

  it.each([
    { name: 'inner-package' },
    { name: 'self-native' },
    { name: 'self-native', exports: null },
  ])('does not borrow parent exports across the nearest scope %j', async (nearest) => {
    const own = await fixture();
    await writeFile(path.join(project, 'src/package.json'), JSON.stringify(nearest));
    const installed = path.join(project, 'node_modules/self-native/index.cjs');
    await mkdir(path.dirname(installed), { recursive: true });
    await writeFile(path.join(path.dirname(installed), 'package.json'), '{"main":"index.cjs"}');
    await writeFile(installed, 'module.exports=43;');
    const original = createRequire(own.entry).resolve(own.specifier);
    const physical = await nodePhysicalFiles(input(project, own.entry, [own.entry, installed]), []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const resolved = createRequire(path.join(archive, physical.nameOf(own.entry))).resolve(
      own.specifier,
    );

    expect(original).toBe(installed);
    expect(physical.links).not.toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.target),
    });
    expect(resolved).toBe(path.join(archive, physical.nameOf(installed)));
  });

  it('refuses a self export whose canonical target is not owned', async () => {
    const own = await fixture();

    await expect(nodePhysicalFiles(input(project, own.entry, [own.entry]), [])).rejects.toThrow(
      'outside its closed trace',
    );
  });

  it.each([{ './*': './build/*' }, { '.': ['./addon.cjs'] }])(
    'refuses unsupported self-export topology without falling through to installed packages: %j',
    async (exports) => {
      const own = await fixture();
      await writeFile(
        path.join(project, 'package.json'),
        JSON.stringify({ name: own.packageName, exports }),
      );

      await expect(
        nodePhysicalFiles(input(project, own.entry, [own.entry, own.target]), []),
      ).rejects.toThrow('unproved export');
    },
  );
});
