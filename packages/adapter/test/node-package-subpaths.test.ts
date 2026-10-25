import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';
import { nodePackageSubpaths } from '../src/node-package-subpaths.ts';

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

describe('closed physical bare package subpaths', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-package-subpath-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    project = path.join(directory, 'repository/app');
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(
    options: {
      readonly subpath?: string;
      readonly filename?: string;
      readonly exports?: unknown;
      readonly direct?: boolean;
      readonly code?: string;
      readonly entryFile?: string;
    } = {},
  ) {
    const filename = options.filename ?? 'addon.cjs';
    const dependency =
      options.direct === true
        ? path.join(project, 'node_modules/pkg')
        : path.join(directory, 'repository/store/pkg');
    const target = path.join(dependency, 'build', filename);
    const logical = path.join(dependency, filename);
    const entry = path.join(project, options.entryFile ?? 'entry.cjs');
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(dependency, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        ...(options.exports !== undefined && { exports: options.exports }),
      }),
    );
    await writeFile(
      target,
      filename.endsWith('.node') ? new Uint8Array([0, 1]) : 'module.exports=42;',
    );
    await symlink(path.relative(dependency, target), logical);
    if (options.direct !== true) await symlink(dependency, path.join(project, 'node_modules/pkg'));
    const specifier = `pkg/${options.subpath ?? filename}`;
    await writeFile(entry, options.code ?? `module.exports=require(${JSON.stringify(specifier)});`);
    return {
      entry,
      dependency,
      target,
      logical,
      specifier,
      build: input(project, entry, [entry, target]),
    };
  }

  it.each([
    { filename: 'addon.cjs', subpath: 'addon.cjs', direct: false },
    { filename: 'addon.node', subpath: 'addon.node', direct: false },
    { filename: 'addon.node', subpath: 'addon', direct: false },
    { filename: 'addon.cjs', subpath: 'addon.cjs', direct: true },
  ])('restores the canonical-only alias for $subpath with direct=$direct', async (options) => {
    const own = await fixture(options);
    const physical = await nodePhysicalFiles(own.build, []);
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

  it('restores an exact exports remap instead of guessing a require condition', async () => {
    const own = await fixture({ subpath: 'api', exports: { './api': './addon.cjs' } });
    const physical = await nodePhysicalFiles(own.build, []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const resolved = createRequire(path.join(archive, physical.nameOf(own.entry))).resolve(
      'pkg/api',
    );

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.target),
    });
    expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
  });

  it('preserves a subpath reached through an internal directory symlink', async () => {
    const own = await fixture({ subpath: 'lib/addon.cjs' });
    await symlink('./build', path.join(own.dependency, 'lib'));
    const physical = await nodePhysicalFiles(own.build, []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const resolved = createRequire(path.join(archive, physical.nameOf(own.entry))).resolve(
      own.specifier,
    );

    expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
    expect(physical.links).toContainEqual({
      path: 'project/store/pkg/lib/addon.cjs',
      target: physical.nameOf(own.target),
    });
  });

  it('preserves both closed import and require export aliases without choosing a condition', async () => {
    const own = await fixture({
      subpath: 'api',
      exports: { './api': { import: './import.mjs', require: './addon.cjs' } },
    });
    const imported = path.join(own.dependency, 'build/import.mjs');
    const importAlias = path.join(own.dependency, 'import.mjs');
    await writeFile(imported, 'export const value=42;');
    await symlink('./build/import.mjs', importAlias);
    const physical = await nodePhysicalFiles(
      input(project, own.entry, [own.entry, own.target, imported]),
      [],
    );

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.target),
    });
    expect(physical.links).toContainEqual({
      path: physical.nameOf(importAlias),
      target: physical.nameOf(imported),
    });
  });

  it('keeps an already-direct import-only export while an unused require branch stays unchanged', async () => {
    const own = await fixture({
      subpath: 'api',
      exports: { './api': { import: './build/addon.cjs', require: './unused.cjs' } },
      code: "export {value} from 'pkg/api';",
      entryFile: 'entry.mjs',
    });
    await writeFile(path.join(own.dependency, 'unused.cjs'), 'module.exports=43;');
    const physical = await nodePhysicalFiles(own.build, []);
    const metadata = await readFile(path.join(own.dependency, 'package.json'), 'utf8');

    expect(physical.links).toStrictEqual([
      { path: 'project/app/node_modules/pkg', target: 'project/store/pkg' },
    ]);
    expect(physical.files.map(({ name }) => name)).not.toContain('project/store/pkg/unused.cjs');
    expect(metadata).toBe(
      new TextDecoder().decode(
        physical.files.find(({ name }) => name === 'project/store/pkg/package.json')?.bytes,
      ),
    );
  });

  it('refuses an internal conditional alias whose physical target is not closed', async () => {
    const own = await fixture({
      subpath: 'api',
      exports: { './api': { import: './untraced.mjs', require: './addon.cjs' } },
    });
    await writeFile(path.join(own.dependency, 'build/untraced.mjs'), 'export const value=43;');
    await symlink('./build/untraced.mjs', path.join(own.dependency, 'untraced.mjs'));

    await expect(nodePhysicalFiles(own.build, [])).rejects.toThrow('outside its closed trace');
  });

  it('restores the external subpath selected by an existing exact package import', async () => {
    const own = await fixture({ code: "module.exports=require('#addon');" });
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ imports: { '#addon': 'pkg/addon.cjs' } }),
    );
    const physical = await nodePhysicalFiles(own.build, []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const resolved = createRequire(path.join(archive, physical.nameOf(own.entry))).resolve(
      '#addon',
    );

    expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.target),
    });
  });

  it('does not invent internal aliases from an unreferenced trace or metadata', async () => {
    const own = await fixture({ code: 'module.exports=42;' });
    const physical = await nodePhysicalFiles(own.build, []);

    expect(physical.links).toStrictEqual([]);
  });

  it('refuses an existing internal target absent from the closed trace', async () => {
    const own = await fixture();
    const anchor = path.join(own.dependency, 'anchor.cjs');
    await writeFile(anchor, 'module.exports=43;');

    await expect(
      nodePhysicalFiles(input(project, own.entry, [own.entry, anchor]), []),
    ).rejects.toThrow('outside its closed trace');
  });

  it('refuses an internal symlink escaping the authorized repository', async () => {
    const own = await fixture();
    const outside = path.join(directory, 'outside.cjs');
    const anchor = path.join(own.dependency, 'anchor.cjs');
    await writeFile(outside, 'module.exports=99;');
    await writeFile(anchor, 'module.exports=43;');
    await rm(own.logical);
    await symlink(outside, own.logical);

    await expect(
      nodePhysicalFiles(input(project, own.entry, [own.entry, anchor]), []),
    ).rejects.toThrow('escapes both its tracing root and build output');
  });

  it.each([
    { './*': './build/*' },
    { './api': ['./addon.cjs'] },
    { './api': '../outside.cjs' },
    { './api': './node_modules/other/addon.cjs' },
  ])('refuses an unproved exports subpath topology %j', async (exports) => {
    const own = await fixture({ subpath: 'api', exports });

    await expect(nodePhysicalFiles(own.build, [])).rejects.toThrow(
      'unproved export or physical topology',
    );
  });
});

describe('bounded exact export candidates', () => {
  it('preserves an exact key ahead of unrelated wildcard mappings', () => {
    expect(
      nodePackageSubpaths('pkg/api', 'pkg', {
        exports: { './api': { import: './a.mjs', default: './b.cjs' }, './*': './unknown/*' },
      }),
    ).toStrictEqual({ exact: true, targets: ['./a.mjs', './b.cjs'] });
  });

  it('rejects excessive conditional depth and candidate count', () => {
    let nested: unknown = './a.cjs';
    for (let index = 0; index < 10; index += 1) nested = { node: nested };
    const branches = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`condition${index}`, `./file${index}.cjs`]),
    );

    expect(() => nodePackageSubpaths('pkg/api', 'pkg', { exports: { './api': nested } })).toThrow(
      'unproved',
    );
    expect(() => nodePackageSubpaths('pkg/api', 'pkg', { exports: { './api': branches } })).toThrow(
      'unproved',
    );
  });

  it('bounds condition nodes even when every branch repeats one target', () => {
    const branches = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`condition${index}`, './same.cjs']),
    );

    expect(() => nodePackageSubpaths('pkg/api', 'pkg', { exports: { './api': branches } })).toThrow(
      'unproved',
    );
  });
});
