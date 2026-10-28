import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';

describe('bare CommonJS file aliases in closed physical archives', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-bare-alias-order-');
    directory = await realpath(await mkdtemp(prefix));
    project = path.join(directory, 'repository/app');
    await mkdir(path.join(project, 'store'), { recursive: true });
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

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

  async function entry(specifier: string, optional = false): Promise<string> {
    const file = path.join(project, 'entry.cjs');
    // Authored source is copied/parsed only; .node fixture bytes are never loaded.
    const call = `module.exports=()=>require(${jsLiteral(specifier)});`;
    await writeFile(file, optional ? `if(process.env.NODE_ENV!=='production'){${call}}` : call);
    return file;
  }

  async function fileAlias(logical: string, name = 'target.cjs'): Promise<string> {
    const target = path.join(project, 'store', name);
    await writeFile(target, 'module.exports="authored inert bytes";');
    await mkdir(path.dirname(logical), { recursive: true });
    await symlink(path.relative(path.dirname(logical), target), logical);
    return target;
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

  async function preserved(
    physical: NodePhysicalFiles,
    importer: string,
    specifier: string,
    target: string,
  ): Promise<void> {
    const archive = await stage(physical);
    const copiedImporter = path.join(archive, physical.nameOf(importer));
    const actual = createRequire(copiedImporter).resolve(specifier);

    expect(actual).toBe(path.join(archive, physical.nameOf(target)));
    await expect(readFile(actual)).resolves.toStrictEqual(await readFile(target));
    await expect(readFile(copiedImporter)).resolves.toStrictEqual(await readFile(importer));
  }

  it.each(['', '.js', '.json', '.node'])(
    'restores the canonical-only %s file alias without evaluating source',
    async (suffix) => {
      const logical = path.join(project, `node_modules/dep${suffix}`);
      const target = await fileAlias(logical);
      const importer = await entry('dep');
      const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

      expect(physical.links).toContainEqual({
        path: physical.nameOf(logical),
        target: physical.nameOf(target),
      });

      await preserved(physical, importer, 'dep', target);
    },
  );

  it.each(['.js', '.json', '.node'])(
    'keeps %s ahead of an untraced same-name directory without exports',
    async (suffix) => {
      const logical = path.join(project, `node_modules/dep${suffix}`);
      const target = await fileAlias(logical);
      const unused = path.join(project, 'node_modules/dep');
      await mkdir(unused);
      await writeFile(path.join(unused, 'package.json'), '{"main":"untraced.js"}');
      await writeFile(path.join(unused, 'untraced.js'), 'throw new Error("never evaluated");');
      const importer = await entry('dep');
      const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

      const metadata = path.join(unused, 'package.json');

      expect(physical.sourcePaths.has(physical.nameOf(metadata))).toBe(false);

      await preserved(physical, importer, 'dep', target);
    },
  );

  it.each(['', '.js', '.json'])(
    'does not let later file candidates supersede %s',
    async (selected) => {
      const suffixes = ['', '.js', '.json', '.node'];
      let target = '';
      const remaining = suffixes.slice(suffixes.indexOf(selected));
      for (const suffix of remaining) {
        const candidate = await fileAlias(
          path.join(project, `node_modules/dep${suffix}`),
          `target${suffix || '.exact'}.cjs`,
        );
        if (suffix === selected) target = candidate;
      }
      const importer = await entry('dep');
      const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

      expect(physical.links).toHaveLength(1);

      await preserved(physical, importer, 'dep', target);
    },
  );

  it('refuses the first unclosed file instead of a later closed candidate', async () => {
    const first = await fileAlias(path.join(project, 'node_modules/dep.js'), 'first.cjs');
    const target = await fileAlias(path.join(project, 'node_modules/dep.json'));
    const importer = await entry('dep');

    expect(createRequire(importer).resolve('dep')).toBe(first);
    await expect(nodePhysicalFiles(input(importer, [importer, target]), [])).rejects.toThrow(
      'first existing Node package target is outside its closed trace',
    );
  });

  it('refuses the first search directory rather than selecting a closed ancestor alias', async () => {
    await fileAlias(path.join(project, 'node_modules/dep.js'), 'first.cjs');
    const target = await fileAlias(path.join(project, '../node_modules/dep.js'));
    const importer = await entry('dep');

    await expect(nodePhysicalFiles(input(importer, [importer, target]), [])).rejects.toThrow(
      'first existing Node package target is outside its closed trace',
    );
  });

  it('finds extension aliases in an ancestor search directory after absent nearer candidates', async () => {
    const logical = path.join(project, '../node_modules/dep.js');
    const target = await fileAlias(logical);
    const importer = await entry('dep');
    const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(logical),
      target: physical.nameOf(target),
    });

    await preserved(physical, importer, 'dep', target);
  });

  it.each(['dep', '@scope/dep'])(
    'keeps the %s package exports path ahead of a same-target file alias',
    async (specifier) => {
      const packageRoot = path.join(project, 'store/package');
      await mkdir(packageRoot);
      const target = path.join(packageRoot, 'entry.cjs');
      await writeFile(target, 'module.exports="authored inert bytes";');
      await writeFile(path.join(packageRoot, 'package.json'), '{"exports":"./entry.cjs"}');
      const logical = path.join(project, 'node_modules', specifier);
      await mkdir(path.dirname(logical), { recursive: true });
      await symlink(path.relative(path.dirname(logical), packageRoot), logical);
      await symlink(path.relative(path.dirname(logical), target), `${logical}.js`);
      const importer = await entry(specifier);
      const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

      expect(physical.links).toContainEqual({
        path: physical.nameOf(logical),
        target: physical.nameOf(packageRoot),
      });
      expect(physical.links.some((link) => link.path === physical.nameOf(`${logical}.js`))).toBe(
        false,
      );

      await preserved(physical, importer, specifier, target);
    },
  );

  it('preserves import-only package exports without guessing require conditions', async () => {
    const packageRoot = path.join(project, 'store/package');
    await mkdir(packageRoot);
    const target = path.join(packageRoot, 'entry.mjs');
    await writeFile(target, 'export const value="authored inert bytes";');
    await writeFile(path.join(packageRoot, 'package.json'), '{"exports":{"import":"./entry.mjs"}}');
    const logical = path.join(project, 'node_modules/dep');
    await symlink('../store/package', logical);
    await fileAlias(`${logical}.js`);
    const importer = path.join(project, 'entry.mjs');
    await writeFile(importer, 'export {value} from "dep";');
    const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(logical),
      target: physical.nameOf(packageRoot),
    });
    expect(physical.links.some((link) => link.path === physical.nameOf(`${logical}.js`))).toBe(
      false,
    );
  });

  it('does not substitute a package root file for a requested subpath', async () => {
    const packageRoot = path.join(project, 'store/package');
    await mkdir(packageRoot);
    const target = path.join(packageRoot, 'part.js');
    await writeFile(target, 'module.exports="authored inert bytes";');
    await writeFile(path.join(packageRoot, 'package.json'), '{}');
    const logical = path.join(project, 'node_modules/dep');
    await symlink('../store/package', logical);
    await fileAlias(`${logical}.js`);
    const importer = await entry('dep/part');
    const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(logical),
      target: physical.nameOf(packageRoot),
    });

    await preserved(physical, importer, 'dep/part', target);
  });

  it('preserves scoped extension aliases', async () => {
    const logical = path.join(project, 'node_modules/@scope/dep.node');
    const target = await fileAlias(logical);
    const importer = await entry('@scope/dep');
    const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

    expect(physical.links).toContainEqual({
      path: physical.nameOf(logical),
      target: physical.nameOf(target),
    });

    await preserved(physical, importer, '@scope/dep', target);
  });

  it('keeps optional aliases as hints when their first candidate is unclosed', async () => {
    await fileAlias(path.join(project, 'node_modules/dep.js'), 'first.cjs');
    const target = await fileAlias(path.join(project, 'node_modules/dep.json'));
    const importer = await entry('dep', true);
    const physical = await nodePhysicalFiles(input(importer, [importer, target]), []);

    expect(physical.links).toStrictEqual([]);
  });
});
