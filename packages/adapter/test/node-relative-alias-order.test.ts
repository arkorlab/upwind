import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';
import { nodeModuleAliases } from '../src/node-module-aliases.ts';
import { nodePhysicalLayout } from '../src/node-physical-layout.ts';

async function stage(physical: NodePhysicalFiles, directory: string): Promise<void> {
  for (const file of physical.files) {
    const target = path.join(directory, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  for (const link of physical.links) {
    const target = path.join(directory, link.path);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.relative(path.dirname(target), path.join(directory, link.target)), target);
  }
}

describe('node relative file-before-directory alias resolution', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-relative-order-');
    directory = await realpath(await mkdtemp(prefix));
    project = path.join(directory, 'repository/app');
    await mkdir(path.join(project, 'build'), { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(
    entryFile: string,
    files: readonly string[],
    distDir = path.join(project, '.next'),
  ): BuildFunctionInput {
    return {
      repoRoot: path.dirname(project),
      projectDir: project,
      patch: { distDir },
      entries: [{ id: '/authored', filePath: entryFile }],
      entryTraces: [
        { id: '/authored', assets: Object.fromEntries(files.map((file) => [file, file])) },
      ],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;
  }

  async function entry(
    specifier: string,
    optional = false,
    file = path.join(project, 'entry.cjs'),
  ) {
    // Authored text is parsed and copied only; no test loads or evaluates this module.
    const call = `module.exports=()=>require(${jsLiteral(specifier)});`;
    await writeFile(file, optional ? `if(process.env.NODE_ENV!=='production'){${call}}` : call);
    return file;
  }

  async function ignoredDirectory(): Promise<string> {
    const logical = path.join(project, 'blog');
    await mkdir(logical);
    const metadata = path.join(logical, 'package.json');
    await writeFile(metadata, '{"main":"untraced.js"}');
    await writeFile(path.join(logical, 'untraced.js'), 'throw new Error("never evaluated");');
    return metadata;
  }

  async function preserved(
    physical: NodePhysicalFiles,
    importer: string,
    specifier: string,
    target: string,
  ): Promise<void> {
    const archive = path.join(directory, 'archive');
    await stage(physical, archive);
    const actual = createRequire(path.join(archive, physical.nameOf(importer))).resolve(specifier);
    const targetBytes = await readFile(target);
    const importerBytes = await readFile(importer);
    const copiedImporter = path.join(archive, physical.nameOf(importer));

    expect(actual).toBe(path.join(archive, physical.nameOf(target)));
    await expect(readFile(actual)).resolves.toStrictEqual(targetBytes);
    await expect(readFile(copiedImporter)).resolves.toStrictEqual(importerBytes);
  }

  it.each(['.js', '.json', '.node'])(
    'uses the closed %s file before an untraced directory package',
    async (suffix) => {
      const metadata = await ignoredDirectory();
      const target = path.join(project, `blog${suffix}`);
      const bytes =
        suffix === '.json' ? '{"authored":42}' : 'module.exports="inert fixture bytes";';
      await writeFile(target, bytes);
      const importer = await entry('./blog');

      expect(createRequire(importer).resolve('./blog')).toBe(target);

      const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

      expect(physical.sourcePaths.has(physical.nameOf(metadata))).toBe(false);

      await preserved(physical, importer, './blog', target);
    },
  );

  it.each([false, true])(
    'preserves a canonical-only file alias before an unused directory, optional=%s',
    async (optional) => {
      await ignoredDirectory();
      const target = path.join(project, 'build/target.js');
      const logical = path.join(project, 'blog.js');
      await writeFile(target, 'module.exports="authored inert value";');
      await symlink(path.relative(project, target), logical);
      const importer = await entry('./blog', optional);
      const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

      expect(physical.links).toContainEqual({
        path: physical.nameOf(logical),
        target: physical.nameOf(target),
      });

      await preserved(physical, importer, './blog', target);
    },
  );

  it('refuses the first unclosed file instead of falling through to a closed directory index', async () => {
    const logical = path.join(project, 'blog');
    await mkdir(logical);
    const target = path.join(logical, 'index.js');
    const first = path.join(project, 'blog.js');
    await writeFile(target, 'module.exports=42;');
    await writeFile(first, 'module.exports="not traced";');
    const importer = await entry('./blog');

    expect(createRequire(importer).resolve('./blog')).toBe(first);
    await expect(nodePhysicalFiles(input(importer, [importer, target]), [])).rejects.toThrow(
      'first existing Node package target is outside its closed trace',
    );
  });

  it('preserves closed directory/main lookup when no earlier file exists', async () => {
    const store = path.join(project, 'store');
    await mkdir(store);
    const target = path.join(store, 'index.js');
    await writeFile(target, 'module.exports=42;');
    await writeFile(path.join(store, 'package.json'), '{"main":"index.js"}');
    const logical = path.join(project, 'blog');
    await symlink('./store', logical);
    const importer = await entry('./blog');
    const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(logical),
      target: physical.nameOf(store),
    });

    await preserved(physical, importer, './blog', target);
  });

  it.each(['./blog/', './blog/.', './blog/child/..'])(
    'keeps the selected directory path for %s even if a file alias has the same target',
    async (specifier) => {
      const logical = path.join(project, 'blog');
      await mkdir(logical);
      const metadata = path.join(logical, 'package.json');
      await writeFile(metadata, '{}');
      const target = path.join(project, 'build/target.js');
      await writeFile(target, 'module.exports=42;');
      await symlink('../build/target.js', path.join(logical, 'index.js'));
      await symlink('./build/target.js', path.join(project, 'blog.js'));
      const importer = await entry(specifier);

      expect(createRequire(importer).resolve(specifier)).toBe(target);

      const physical = await nodePhysicalFiles(input(importer, [importer, target, metadata]), []);

      expect(physical.links).toContainEqual({
        path: physical.nameOf(path.join(logical, 'index.js')),
        target: physical.nameOf(target),
      });

      await preserved(physical, importer, specifier, target);
    },
  );

  it('still requires closed metadata when Node actually selected a directory package', async () => {
    const logical = path.join(project, 'blog');
    await mkdir(logical);
    const target = path.join(logical, 'index.js');
    await writeFile(target, 'module.exports=42;');
    await writeFile(path.join(logical, 'package.json'), '{"main":"index.js"}');
    const importer = await entry('./blog');
    const build = input(importer, [importer, target]);
    const layout = await nodePhysicalLayout(build);
    const sources = {
      originals: new Map([importer, target].map((file) => [file, layout.nameOf(file)])),
      files: new Map(
        await Promise.all(
          [importer, target].map(
            async (file) => [layout.nameOf(file), await readFile(file)] as const,
          ),
        ),
      ),
    };

    await expect(nodeModuleAliases(sources, layout, new Map())).rejects.toThrow(
      'relative package entry has no closed metadata',
    );
  });

  it('preserves index.js rather than a same-target extensionless index which Node did not select', async () => {
    const logical = path.join(project, 'blog');
    await mkdir(logical);
    const metadata = path.join(logical, 'package.json');
    await writeFile(metadata, '{}');
    const target = path.join(project, 'build/target.js');
    await writeFile(target, 'module.exports=42;');
    await symlink('../build/target.js', path.join(logical, 'index'));
    await symlink('../build/target.js', path.join(logical, 'index.js'));
    const importer = await entry('./blog');
    const physical = await nodePhysicalFiles(input(importer, [importer, target, metadata]), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(path.join(logical, 'index.js')),
      target: physical.nameOf(target),
    });

    await preserved(physical, importer, './blog', target);
  });

  it('keeps the existing relative topology refusal across a relocated external output', async () => {
    const distDir = path.join(directory, 'external-output');
    await mkdir(distDir);
    const target = path.join(project, 'build/blog.js');
    await writeFile(target, 'module.exports=42;');
    const specifier = `./${path.relative(distDir, target).slice(0, -3).split(path.sep).join('/')}`;
    const importer = await entry(specifier, false, path.join(distDir, 'entry.cjs'));

    expect(createRequire(importer).resolve(specifier)).toBe(target);
    await expect(
      nodePhysicalFiles(input(importer, [importer, target], distDir), []),
    ).rejects.toThrow('relocation changes a relative module or native binary lookup');
  });
});
