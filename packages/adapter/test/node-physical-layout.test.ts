import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';

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

describe('declared and canonical physical layout roots', () => {
  let directory: string;
  let repository: string;
  let project: string;
  let declaredRoot: string;
  let output: string;
  let declaredOutput: string;
  let target: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-physical-roots-'));
    directory = await realpath(temporary);
    repository = path.join(directory, 'actual/repo');
    project = path.join(repository, 'app');
    declaredRoot = path.join(directory, 'logical/repo');
    output = path.join(directory, 'actual/output');
    declaredOutput = path.join(directory, 'logical/output');
    target = path.join(repository, 'store/data.bin');
    await mkdir(project, { recursive: true });
    await mkdir(path.dirname(target));
    await mkdir(path.join(output, 'server'), { recursive: true });
    await mkdir(path.dirname(declaredRoot));
    await symlink(repository, declaredRoot);
    await symlink(output, declaredOutput);
    await writeFile(target, new Uint8Array([4, 8, 15]));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(entry: string, key: string): BuildFunctionInput {
    return {
      repoRoot: declaredRoot,
      projectDir: path.join(declaredRoot, 'app'),
      patch: { distDir: declaredOutput },
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [{ id: '/native', assets: { [key]: target } }],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;
  }

  it('resolves declared-root-relative NFT keys while retaining the final raw data alias', async () => {
    const entry = path.join(project, 'entry.cjs');
    const alias = path.join(project, 'data.bin');
    await writeFile(entry, 'module.exports=42;');
    await symlink('../store/data.bin', alias);
    const key = path.relative(declaredRoot, alias);
    const physical = await nodePhysicalFiles(input(entry, key), []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const bytes = await readFile(path.join(archive, 'project/app/data.bin'));

    expect(key.startsWith('..')).toBe(true);
    expect(physical.links).toStrictEqual([
      { path: 'project/app/data.bin', target: 'project/store/data.bin' },
    ]);
    expect(physical.nameOf(path.join(declaredRoot, 'app/data.bin'))).toBe('project/app/data.bin');
    expect([...bytes]).toStrictEqual([4, 8, 15]);
  });

  it('rebases a declared dist prefix without following its final data alias', async () => {
    const entry = path.join(output, 'server/entry.cjs');
    const alias = path.join(declaredOutput, 'server/data.bin');
    await writeFile(entry, 'module.exports=42;');
    await symlink(target, alias);
    const physical = await nodePhysicalFiles(input(entry, path.relative(declaredRoot, alias)), []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const bytes = await readFile(path.join(archive, 'project/app/.upwind-build/server/data.bin'));

    expect(physical.links).toStrictEqual([
      { path: 'project/app/.upwind-build/server/data.bin', target: 'project/store/data.bin' },
    ]);
    expect(physical.nameOf(alias)).toBe('project/app/.upwind-build/server/data.bin');
    expect([...bytes]).toStrictEqual([4, 8, 15]);
  });

  it('prioritizes the declared dist prefix when it is a symlink inside the declared root', async () => {
    const entry = path.join(output, 'server/entry.cjs');
    const distDir = path.join(declaredRoot, 'app/.next');
    const alias = path.join(distDir, 'server/data.bin');
    await symlink(output, path.join(project, '.next'));
    await writeFile(entry, 'module.exports=42;');
    await symlink(target, alias);
    const build = input(entry, path.relative(declaredRoot, alias));
    const physical = await nodePhysicalFiles({ ...build, patch: { ...build.patch, distDir } }, []);

    expect(physical.links).toStrictEqual([
      { path: 'project/app/.upwind-build/server/data.bin', target: 'project/store/data.bin' },
    ]);
    expect(physical.nameOf(alias)).toBe('project/app/.upwind-build/server/data.bin');
  });

  it('does not authorize an unrelated logical alias merely because its target is owned', async () => {
    const entry = path.join(project, 'entry.cjs');
    const alias = path.join(directory, 'logical/repo-extra/data.bin');
    await writeFile(entry, 'module.exports=42;');
    await mkdir(path.dirname(alias));
    await symlink(target, alias);
    const key = path.relative(declaredRoot, alias);

    await expect(nodePhysicalFiles(input(entry, key), [])).rejects.toThrow(
      'escapes both its tracing root and build output',
    );
  });
});
