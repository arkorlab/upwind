import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

describe('closed physical package import aliases', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-package-import-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    project = path.join(directory, 'repository/app');
    await mkdir(path.join(project, 'sub'), { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(
    imports?: unknown,
    code = "module.exports=require('#dep');",
    filename = 'entry.cjs',
  ) {
    const entry = path.join(project, 'sub', filename);
    const dependency = path.join(directory, 'repository/store/dep');
    const target = path.join(dependency, 'index.cjs');
    await mkdir(dependency, { recursive: true });
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    const mappings = imports === undefined ? { '#dep': 'dep' } : imports;
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'app', imports: mappings }),
    );
    await writeFile(path.join(dependency, 'package.json'), '{"name":"dep","main":"index.cjs"}');
    await writeFile(target, 'module.exports=42;');
    await writeFile(entry, code);
    await symlink(dependency, path.join(project, 'node_modules/dep'));
    return { entry, target, dependency, build: input(project, entry, [entry, target]) };
  }

  it.each([
    { code: "module.exports=require('#dep');", filename: 'entry.cjs' },
    { code: 'module.exports=require(`#dep`);', filename: 'entry.cjs' },
    { code: "export {value} from '#dep';", filename: 'entry.mjs' },
    { code: 'module.exports=()=>import(`#dep`);', filename: 'entry.cjs' },
  ])('restores a canonical-only external package alias for $code', async ({ code, filename }) => {
    const own = await fixture({ '#dep': 'dep' }, code, filename);
    const physical = await nodePhysicalFiles(own.build, []);

    expect(physical.links).toStrictEqual([
      { path: 'project/app/node_modules/dep', target: 'project/store/dep' },
    ]);
    expect(physical.files.map(({ name }) => name)).toContain('project/app/package.json');
    expect(physical.files.map(({ name }) => name)).toContain('project/store/dep/package.json');
  });

  it('preserves Node resolution after staging without executing dependency code', async () => {
    const own = await fixture();
    const physical = await nodePhysicalFiles(own.build, []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const resolved = createRequire(path.join(archive, physical.nameOf(own.entry))).resolve('#dep');
    const archivedMetadata = await readFile(path.join(archive, 'project/app/package.json'), 'utf8');
    const originalMetadata = await readFile(path.join(project, 'package.json'), 'utf8');

    expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
    expect(archivedMetadata).toBe(originalMetadata);
  });

  it('does not create an orphan alias from an unused imports map or canonical trace alone', async () => {
    const own = await fixture({ '#dep': 'dep' }, 'module.exports=42;');
    const physical = await nodePhysicalFiles(own.build, []);

    expect(physical.links).toStrictEqual([]);
  });

  it('resolves an external target from package scope instead of a nearer importer shadow', async () => {
    const own = await fixture();
    const shadow = path.join(project, 'sub/node_modules/dep');
    const target = path.join(shadow, 'index.cjs');
    await mkdir(shadow, { recursive: true });
    await writeFile(path.join(shadow, 'package.json'), '{"name":"dep","main":"index.cjs"}');
    await writeFile(target, 'module.exports=43;');
    const physical = await nodePhysicalFiles(
      input(project, own.entry, [own.entry, own.target, target]),
      [],
    );

    expect(physical.links).toStrictEqual([
      { path: 'project/app/node_modules/dep', target: 'project/store/dep' },
    ]);
  });

  it('selects an exact mapping ahead of an unrelated pattern without guessing the pattern', async () => {
    const own = await fixture({ '#dep': 'dep', '#*': { default: './unknown/*' } });
    const physical = await nodePhysicalFiles(own.build, []);

    expect(physical.links).toStrictEqual([
      { path: 'project/app/node_modules/dep', target: 'project/store/dep' },
    ]);
  });

  it('preserves a proved exact relative target and its logical file symlink', async () => {
    const own = await fixture({ '#dep': './local.cjs' });
    await symlink(own.target, path.join(project, 'local.cjs'));
    const physical = await nodePhysicalFiles(own.build, []);
    const archive = path.join(directory, 'archive');
    await staged(physical, archive);
    const resolved = createRequire(path.join(archive, physical.nameOf(own.entry))).resolve('#dep');

    expect(physical.links).toStrictEqual([
      { path: 'project/app/local.cjs', target: 'project/store/dep/index.cjs' },
    ]);
    expect(resolved).toBe(path.join(archive, physical.nameOf(own.target)));
  });

  it('refuses a builtin package-import mapping not resolved by the supported CommonJS loader', async () => {
    const own = await fixture({ '#dep': 'fs' });

    await expect(nodePhysicalFiles(own.build, [])).rejects.toThrow('unproved builtin target');
  });

  it.each([
    { '#dep': { node: 'dep', default: './fallback.cjs' } },
    { '#dep': ['dep', './fallback.cjs'] },
    { '#dep': '#other', '#other': 'dep' },
    { '#d*': 'dep' },
    { '#dep': './sub/../outside.cjs' },
    { '#dep': '../outside.cjs' },
    { '#dep': './node_modules/dep/index.cjs' },
    { '#dep': 'dep/../other' },
    { '#dep': 'file:///outside.cjs' },
    { '#dep': 'node:fs' },
    { '#dep': null },
    [],
  ])('refuses unsupported or malformed package-import metadata %j', async (imports) => {
    const own = await fixture(imports);

    await expect(nodePhysicalFiles(own.build, [])).rejects.toThrow(/Node package import/u);
  });

  it('refuses the first physical dependency when no file in it belongs to the trace', async () => {
    const own = await fixture();

    await expect(nodePhysicalFiles(input(project, own.entry, [own.entry]), [])).rejects.toThrow(
      'outside its closed trace',
    );
  });

  it('rejects an external mapping whose first alias target is outside the authorized repository', async () => {
    const own = await fixture();
    const outside = path.join(directory, 'outside');
    const alias = path.join(project, 'node_modules/dep');
    await mkdir(outside);
    await writeFile(path.join(outside, 'index.cjs'), 'module.exports=99;');
    await rm(alias);
    await symlink(outside, alias);

    await expect(nodePhysicalFiles(own.build, [])).rejects.toThrow(
      'escapes both its tracing root and build output',
    );
  });

  it('does not borrow an imports map from outside the closest package scope', async () => {
    const own = await fixture();
    const manifest = path.join(project, 'sub/package.json');
    await writeFile(manifest, '{"name":"inner"}');

    await expect(nodePhysicalFiles(own.build, [])).rejects.toThrow('proved exact mapping');
  });

  it('does not cross a node_modules boundary to borrow an outer imports map', async () => {
    await fixture();
    const entry = path.join(project, 'node_modules/owner/entry.cjs');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "module.exports=require('#dep');");

    await expect(nodePhysicalFiles(input(project, entry, [entry]), [])).rejects.toThrow(
      'no closed package scope',
    );
  });
});
