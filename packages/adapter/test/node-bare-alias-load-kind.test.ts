import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';

describe('bare aliases retain each original Node load kind', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-bare-alias-load-kind-');
    directory = await realpath(await mkdtemp(prefix));
    project = path.join(directory, 'repository/app');
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await mkdir(path.join(project, 'store/package'), { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(code: string, extension = 'mjs') {
    const importer = path.join(project, `entry.${extension}`);
    const packageRoot = path.join(project, 'store/package');
    const packageFile = path.join(packageRoot, 'entry.cjs');
    const metadata = path.join(packageRoot, 'package.json');
    const sibling = path.join(project, 'store/sibling.cjs');
    const logical = path.join(project, 'node_modules/dep');
    await writeFile(importer, code);
    await writeFile(packageFile, 'module.exports={value:"authored package bytes"};');
    await writeFile(metadata, '{"main":"entry.cjs"}');
    await writeFile(sibling, 'module.exports="authored sibling bytes";');
    await symlink('../store/package', logical);
    await symlink('../store/sibling.cjs', `${logical}.js`);
    return { importer, packageRoot, packageFile, metadata, sibling, logical };
  }

  function input(importer: string, files: readonly string[]): BuildFunctionInput {
    return {
      repoRoot: path.dirname(project),
      projectDir: project,
      patch: { distDir: path.join(project, '.next') },
      entries: [{ id: '/authored', filePath: importer }],
      entryTraces: [
        { id: '/authored', assets: Object.fromEntries(files.map((file) => [file, file])) },
      ],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;
  }

  async function stage(physical: NodePhysicalFiles): Promise<string> {
    const archive = path.join(directory, 'archive');
    for (const file of physical.files) {
      const target = path.join(archive, file.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
    for (const link of physical.links) {
      const target = path.join(archive, link.path);
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(path.relative(path.dirname(target), path.join(archive, link.target)), target);
    }
    return archive;
  }

  async function ancestorPackage(own: Awaited<ReturnType<typeof fixture>>, link: boolean) {
    await rm(own.logical);
    if (link) await symlink('../store/sibling.cjs', own.logical);
    else await writeFile(own.logical, 'module.exports="authored exact file bytes";');
    const ancestor = path.join(project, '../node_modules/dep');
    await mkdir(path.dirname(ancestor), { recursive: true });
    await symlink(path.relative(path.dirname(ancestor), own.packageRoot), ancestor);
    return { ancestor, first: link ? own.sibling : own.logical };
  }

  function packageTrace(
    own: Awaited<ReturnType<typeof fixture>>,
    first: string,
    owned: boolean,
  ): string[] {
    const files = [own.importer, own.packageFile, own.metadata];
    if (owned) files.push(first);
    return files;
  }

  it.each([
    `import 'dep';`,
    `import {value} from 'dep';export const result=value;`,
    `export * from 'dep';`,
    `export {value} from 'dep';`,
    `export const lazy=()=>import('dep');`,
  ])('keeps the ESM package lookup despite an untraced dep.js: %s', async (code) => {
    const own = await fixture(code);
    const files = [own.importer, own.packageFile, own.metadata];
    const physical = await nodePhysicalFiles(input(own.importer, files), []);
    const archive = await stage(physical);
    const copiedPackage = path.join(archive, physical.nameOf(own.logical));
    const copiedImporter = path.join(archive, physical.nameOf(own.importer));

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.packageRoot),
    });
    expect(physical.links.some((link) => link.path === physical.nameOf(`${own.logical}.js`))).toBe(
      false,
    );
    await expect(realpath(copiedPackage)).resolves.toBe(
      path.join(archive, physical.nameOf(own.packageRoot)),
    );
    await expect(readFile(path.join(copiedPackage, 'entry.cjs'))).resolves.toStrictEqual(
      await readFile(own.packageFile),
    );
    await expect(readFile(copiedImporter)).resolves.toStrictEqual(await readFile(own.importer));
  });

  it.each([
    { link: false, owned: false },
    { link: false, owned: true },
    { link: true, owned: false },
    { link: true, owned: true },
  ])(
    'skips a nearer ESM exact file while retaining ancestor directory lookup: %j',
    async (shape) => {
      const own = await fixture(`import 'dep';`);
      const { ancestor, first } = await ancestorPackage(own, shape.link);
      const files = packageTrace(own, first, shape.owned);
      const physical = await nodePhysicalFiles(input(own.importer, files), []);
      const archive = await stage(physical);
      const copiedAncestor = path.join(archive, physical.nameOf(ancestor));

      expect(physical.links).toContainEqual({
        path: physical.nameOf(ancestor),
        target: physical.nameOf(own.packageRoot),
      });
      expect(physical.links.some((link) => link.path === physical.nameOf(own.logical))).toBe(false);
      await expect(realpath(copiedAncestor)).resolves.toBe(
        path.join(archive, physical.nameOf(own.packageRoot)),
      );
    },
  );

  it.each([false, true])(
    'keeps the nearer CommonJS exact file and ancestor ESM package for both modes, symlink=%s',
    async (link) => {
      const own = await fixture(`import('dep');require('dep');`, 'cjs');
      const { ancestor, first } = await ancestorPackage(own, link);
      const files = [own.importer, own.packageFile, own.metadata, first];
      const physical = await nodePhysicalFiles(input(own.importer, files), []);
      const archive = await stage(physical);
      const copiedImporter = path.join(archive, physical.nameOf(own.importer));
      const copiedFirst = path.join(archive, physical.nameOf(first));

      expect(physical.links).toContainEqual({
        path: physical.nameOf(ancestor),
        target: physical.nameOf(own.packageRoot),
      });
      expect(createRequire(copiedImporter).resolve('dep')).toBe(copiedFirst);
      await expect(readFile(copiedFirst)).resolves.toStrictEqual(await readFile(first));
    },
  );

  it('refuses the first selected ESM directory outside its closed trace after skipping a file', async () => {
    const own = await fixture(`import 'dep';`);
    await ancestorPackage(own, false);

    await expect(nodePhysicalFiles(input(own.importer, [own.importer]), [])).rejects.toThrow(
      'first existing Node package target is outside its closed trace',
    );
  });

  it.each([
    `require('dep');import('dep');`,
    `import('dep');require('dep');`,
    `require('dep');import('dep');require('dep');import('dep');`,
  ])('preserves both independent lookup paths for one specifier: %s', async (code) => {
    const own = await fixture(code, 'cjs');
    const files = [own.importer, own.packageFile, own.metadata, own.sibling];
    const physical = await nodePhysicalFiles(input(own.importer, files), []);
    const archive = await stage(physical);
    const copiedImporter = path.join(archive, physical.nameOf(own.importer));

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.packageRoot),
    });
    expect(physical.links).toContainEqual({
      path: physical.nameOf(`${own.logical}.js`),
      target: physical.nameOf(own.sibling),
    });
    expect(createRequire(copiedImporter).resolve('dep')).toBe(
      path.join(archive, physical.nameOf(own.sibling)),
    );
  });

  it('does not demote an import-only hint because require of the same specifier is required', async () => {
    const own = await fixture(
      `require('dep');if(process.env.NODE_ENV!=='production')import('dep');`,
      'cjs',
    );
    const files = [own.importer, own.packageFile, own.metadata, own.sibling];
    const physical = await nodePhysicalFiles(input(own.importer, files), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.packageRoot),
    });
    expect(physical.links).toContainEqual({
      path: physical.nameOf(`${own.logical}.js`),
      target: physical.nameOf(own.sibling),
    });
  });

  it('does not demote a CommonJS hint because import of the same specifier is required', async () => {
    const own = await fixture(
      `import('dep');if(process.env.NODE_ENV!=='production')require('dep');`,
      'cjs',
    );
    const files = [own.importer, own.packageFile, own.metadata, own.sibling];
    const physical = await nodePhysicalFiles(input(own.importer, files), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.packageRoot),
    });
    expect(physical.links).toContainEqual({
      path: physical.nameOf(`${own.logical}.js`),
      target: physical.nameOf(own.sibling),
    });
  });

  it('retains ESM lookup through an external package imports mapping', async () => {
    const own = await fixture(`import '#dep';`);
    await writeFile(path.join(project, 'package.json'), '{"imports":{"#dep":"dep"}}');
    const files = [own.importer, own.packageFile, own.metadata];
    const physical = await nodePhysicalFiles(input(own.importer, files), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.logical),
      target: physical.nameOf(own.packageRoot),
    });
    expect(physical.links.some((link) => link.path === physical.nameOf(`${own.logical}.js`))).toBe(
      false,
    );
  });

  it('retains CommonJS lookup through an external package imports mapping', async () => {
    const own = await fixture(`require('#dep');`, 'cjs');
    await writeFile(path.join(project, 'package.json'), '{"imports":{"#dep":"dep"}}');
    const files = [own.importer, own.sibling];
    const physical = await nodePhysicalFiles(input(own.importer, files), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(`${own.logical}.js`),
      target: physical.nameOf(own.sibling),
    });
  });
});
