import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';

describe('trace-only assets beneath a linked package', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-trace-package-alias-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(childLink = true) {
    const root = path.join(directory, 'owned');
    const project = path.join(root, 'app');
    const store = path.join(root, 'store/pkg');
    const packageAlias = path.join(project, 'node_modules/pkg');
    await mkdir(store, { recursive: true });
    await mkdir(path.dirname(packageAlias), { recursive: true });
    const asset = path.join(store, childLink ? 'actual.txt' : 'data.txt');
    const logical = path.join(packageAlias, 'data.txt');
    const entry = path.join(project, 'entry.cjs');
    await writeFile(asset, 'authored filesystem asset');
    await writeFile(path.join(store, 'package.json'), '{"main":"index.js"}');
    const packageEntry = path.join(store, 'index.js');
    // These are inert bytes: the test never loads either module or its filesystem code.
    await writeFile(
      packageEntry,
      'module.exports=()=>require("node:fs").readFileSync(__dirname+"/data.txt");',
    );
    await writeFile(entry, 'module.exports=()=>require("pkg");');
    await symlink(path.relative(path.dirname(packageAlias), store), packageAlias);
    if (childLink) await symlink('actual.txt', path.join(store, 'data.txt'));
    const assets = {
      [entry]: entry,
      [packageEntry]: packageEntry,
      [path.relative(root, logical)]: asset,
    };
    const input = {
      repoRoot: root,
      projectDir: project,
      patch: { distDir: path.join(project, '.next') },
      entries: [{ id: '/authored', filePath: entry }],
      entryTraces: [{ id: '/authored', assets }],
      files: [],
      edgeEntries: [],
      manifests: [],
    };
    return { input, asset, packageAlias, project, root, store };
  }

  it('preserves a nonredundant asset filename at the package alias physical parent', async () => {
    const own = await fixture();
    const result = await nodePhysicalFiles(own.input as unknown as BuildFunctionInput, []);

    expect(result.links).toContainEqual({
      path: 'project/app/node_modules/pkg',
      target: 'project/store/pkg',
    });
    expect(result.links).toContainEqual({
      path: 'project/store/pkg/data.txt',
      target: 'project/store/pkg/actual.txt',
    });
    expect(result.links.some((link) => link.path === 'project/app/node_modules/pkg/data.txt')).toBe(
      false,
    );

    const asset = result.files.find((file) => file.name === 'project/store/pkg/actual.txt');

    expect(new TextDecoder().decode(asset?.bytes)).toBe('authored filesystem asset');
  });

  it('omits a redundant child alias when only the package parent is linked', async () => {
    const own = await fixture(false);
    const result = await nodePhysicalFiles(own.input as unknown as BuildFunctionInput, []);

    expect(result.links).toStrictEqual([
      { path: 'project/app/node_modules/pkg', target: 'project/store/pkg' },
    ]);
    expect(result.files.some((file) => file.name === 'project/store/pkg/data.txt')).toBe(true);
  });

  it('keeps a logical asset path when no emitted parent represents its directory', async () => {
    const own = await fixture();
    const stored = path.join(own.root, 'extra-assets');
    const parent = path.join(own.project, 'static-data');
    const asset = path.join(stored, 'data.txt');
    await mkdir(stored);
    await writeFile(asset, 'authored directory asset');
    await symlink(path.relative(own.project, stored), parent);
    own.input.entryTraces[0]!.assets[path.relative(own.root, path.join(parent, 'data.txt'))] =
      asset;
    const result = await nodePhysicalFiles(own.input as unknown as BuildFunctionInput, []);

    expect(result.links).toContainEqual({
      path: 'project/app/static-data/data.txt',
      target: 'project/extra-assets/data.txt',
    });
  });

  it('refuses an unrepresented intermediate directory beneath an emitted package parent', async () => {
    const own = await fixture();
    const stored = path.join(own.root, 'elsewhere');
    const asset = path.join(stored, 'data.txt');
    await mkdir(stored);
    await writeFile(asset, 'authored intermediate asset');
    await symlink(path.relative(own.store, stored), path.join(own.store, 'nested'));
    const logical = path.join(own.packageAlias, 'nested/data.txt');
    own.input.entryTraces[0]!.assets[path.relative(own.root, logical)] = asset;

    await expect(nodePhysicalFiles(own.input as unknown as BuildFunctionInput, [])).rejects.toThrow(
      'unsupported intermediate topology',
    );
  });

  it('refuses a child alias whose physical parent escapes the owned roots', async () => {
    const own = await fixture();
    const outside = path.join(directory, 'outside');
    const parent = path.join(own.project, 'bridged-assets');
    await mkdir(outside);
    await symlink(path.relative(own.project, outside), parent);
    await symlink(path.relative(outside, own.asset), path.join(outside, 'data.txt'));
    own.input.entryTraces[0]!.assets[path.relative(own.root, path.join(parent, 'data.txt'))] =
      own.asset;

    await expect(nodePhysicalFiles(own.input as unknown as BuildFunctionInput, [])).rejects.toThrow(
      'escapes both its tracing root and build output',
    );
  });
});
