import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';

describe('native physical module relocation', () => {
  let directory: string;
  let repository: string;
  let project: string;
  let output: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), 'upwind-node-topology-')));
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
});
