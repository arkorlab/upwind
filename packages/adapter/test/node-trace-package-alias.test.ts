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

  it('refuses a nonredundant child asset before a package alias can hide its filename', async () => {
    const project = path.join(directory, 'app');
    const store = path.join(directory, 'store/pkg');
    const packageAlias = path.join(project, 'node_modules/pkg');
    await mkdir(store, { recursive: true });
    await mkdir(path.dirname(packageAlias), { recursive: true });
    const asset = path.join(store, 'actual.txt');
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
    await symlink('actual.txt', path.join(store, 'data.txt'));
    const assets = {
      [entry]: entry,
      [packageEntry]: packageEntry,
      [path.relative(directory, logical)]: asset,
    };
    const input = {
      repoRoot: directory,
      projectDir: project,
      patch: { distDir: path.join(project, '.next') },
      entries: [{ id: '/authored', filePath: entry }],
      entryTraces: [{ id: '/authored', assets }],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;

    await expect(nodePhysicalFiles(input, [])).rejects.toThrow(
      'required aliases have incompatible topology',
    );
  });
});
