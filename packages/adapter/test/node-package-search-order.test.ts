import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';

describe('legacy CommonJS subpaths keep the actually selected package root', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-package-search-order-');
    directory = await realpath(await mkdtemp(prefix));
    project = path.join(directory, 'repository/app');
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(
    packageName = 'dep',
    importMode = false,
    otherFirst = false,
    rootRequest = false,
  ) {
    const near = path.join(directory, 'repository/store/near');
    const far = path.join(directory, 'repository/store/far');
    const nearer = path.join(project, 'node_modules', packageName);
    const ancestor = path.join(project, '../node_modules', packageName);
    const entry = path.join(project, importMode ? 'entry.mjs' : 'entry.cjs');
    await mkdir(path.join(near, 'build'), { recursive: true });
    await mkdir(path.join(far, 'build'), { recursive: true });
    const other = path.join(near, 'build/other.cjs');
    const target = path.join(far, 'build/addon.cjs');
    await writeFile(other, 'module.exports="authored nearer bytes";');
    await writeFile(target, 'module.exports="authored ancestor bytes";');
    for (const root of [near, far])
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: packageName,
          ...(root === far && rootRequest && { main: './addon.js' }),
        }),
      );
    await symlink('./build/other.cjs', path.join(near, 'other.js'));
    await symlink('./build/addon.cjs', path.join(far, 'addon.js'));
    for (const [logical, root] of [
      [nearer, near],
      [ancestor, far],
    ] as const) {
      await mkdir(path.dirname(logical), { recursive: true });
      await symlink(path.relative(path.dirname(logical), root), logical);
    }
    const requested = rootRequest ? packageName : `${packageName}/addon`;
    const otherSpecifier = `${packageName}/other`;
    const loads = otherFirst ? [otherSpecifier, requested] : [requested, otherSpecifier];
    const imported = jsLiteral(rootRequest ? packageName : `${packageName}/addon.js`);
    const code = importMode
      ? `import ${imported};`
      : loads.map((value) => `require(${jsLiteral(value)});`).join('\n');
    await writeFile(entry, code);
    return { entry, near, far, nearer, ancestor, other, target, requested, otherSpecifier };
  }

  function input(entry: string, files: readonly string[]): BuildFunctionInput {
    return {
      repoRoot: path.dirname(project),
      projectDir: project,
      patch: { distDir: path.join(project, '.next') },
      entries: [{ id: '/authored', filePath: entry }],
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

  it.each([{}, { main: '' }, { main: false }, { main: 0 }, { main: null }])(
    'restores a root ancestor while a nearer package retains another traced subpath: %j',
    async (metadata) => {
      const own = await fixture('dep', false, false, true);
      await writeFile(path.join(own.near, 'package.json'), JSON.stringify(metadata));
      const files = [own.entry, own.other, own.target];
      const physical = await nodePhysicalFiles(input(own.entry, files), []);
      const archive = await stage(physical);
      const copiedEntry = path.join(archive, physical.nameOf(own.entry));

      expect(createRequire(own.entry).resolve('dep')).toBe(own.target);
      expect(createRequire(copiedEntry).resolve('dep')).toBe(
        path.join(archive, physical.nameOf(own.target)),
      );
      expect(createRequire(copiedEntry).resolve(own.otherSpecifier)).toBe(
        path.join(archive, physical.nameOf(own.other)),
      );
      expect(physical.links).toContainEqual({
        path: physical.nameOf(own.nearer),
        target: physical.nameOf(own.near),
      });
      expect(physical.links).toContainEqual({
        path: physical.nameOf(own.ancestor),
        target: physical.nameOf(own.far),
      });
    },
  );

  it('refuses a nearer unowned root index instead of the closed ancestor', async () => {
    const own = await fixture('dep', false, false, true);
    const first = path.join(own.near, 'index.js');
    await writeFile(first, 'module.exports="authored untraced index";');

    expect(createRequire(own.entry).resolve('dep')).toBe(first);
    await expect(
      nodePhysicalFiles(input(own.entry, [own.entry, own.other, own.target]), []),
    ).rejects.toThrow('first existing Node package target is outside its closed trace');
  });

  it('keeps invalid truthy root main fatal even with a closed ancestor', async () => {
    const own = await fixture('dep', false, false, true);
    await writeFile(path.join(own.near, 'package.json'), '{"main":"./missing.cjs"}');

    expect(() => createRequire(own.entry).resolve('dep')).toThrow(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    );
    await expect(
      nodePhysicalFiles(input(own.entry, [own.entry, own.other, own.target]), []),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' });
  });

  it('keeps a selected root main inside its existing finite package boundary', async () => {
    const own = await fixture('dep', false, false, true);
    const escaped = path.join(own.nearer, '../outside.cjs');
    await writeFile(escaped, 'module.exports="authored outside-package bytes";');
    await writeFile(path.join(own.near, 'package.json'), '{"main":"../outside.cjs"}');

    expect(createRequire(own.entry).resolve('dep')).toBe(escaped);
    await expect(
      nodePhysicalFiles(input(own.entry, [own.entry, own.other, own.target, escaped]), []),
    ).rejects.toThrow('relative package entry escapes its closed physical directory');
  });

  it('retains bare file precedence over an unused invalid directory main', async () => {
    const own = await fixture('dep', false, false, true);
    await writeFile(path.join(own.near, 'package.json'), '{"main":"./missing.cjs"}');
    const sibling = `${own.nearer}.js`;
    await symlink(path.relative(path.dirname(sibling), own.target), sibling);
    const physical = await nodePhysicalFiles(
      input(own.entry, [own.entry, own.other, own.target]),
      [],
    );
    const archive = await stage(physical);
    const copiedEntry = path.join(archive, physical.nameOf(own.entry));

    expect(createRequire(copiedEntry).resolve('dep')).toBe(
      path.join(archive, physical.nameOf(own.target)),
    );
    expect(physical.links).toContainEqual({
      path: physical.nameOf(sibling),
      target: physical.nameOf(own.target),
    });
  });

  it('keeps a nearer root exports boundary sealed against ancestor fallback', async () => {
    const own = await fixture('dep', false, false, true);
    await writeFile(path.join(own.near, 'package.json'), '{"exports":{"./other":"./other.js"}}');

    await expect(
      nodePhysicalFiles(input(own.entry, [own.entry, own.other, own.target]), []),
    ).rejects.toThrow('unproved export or physical topology');
  });

  it('still keeps an ESM root on its first directory without a legacy entrypoint', async () => {
    const own = await fixture('dep', true, false, true);
    const physical = await nodePhysicalFiles(
      input(own.entry, [own.entry, own.other, own.target]),
      [],
    );

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.nearer),
      target: physical.nameOf(own.near),
    });
    expect(physical.links.some((link) => link.path === physical.nameOf(own.ancestor))).toBe(false);
  });

  it.each([
    { packageName: 'dep', otherFirst: false },
    { packageName: 'dep', otherFirst: true },
    { packageName: '@scope/dep', otherFirst: false },
  ])('restores both roots and internal subpath links for %j', async (options) => {
    const own = await fixture(options.packageName, false, options.otherFirst);
    const files = [own.entry, own.other, own.target];
    const physical = await nodePhysicalFiles(input(own.entry, files), []);
    const archive = await stage(physical);
    const copiedEntry = path.join(archive, physical.nameOf(own.entry));
    const copiedTarget = path.join(archive, physical.nameOf(own.target));

    expect(createRequire(own.entry).resolve(own.requested)).toBe(own.target);
    expect(createRequire(copiedEntry).resolve(own.requested)).toBe(
      path.join(archive, physical.nameOf(own.target)),
    );
    expect(createRequire(copiedEntry).resolve(own.otherSpecifier)).toBe(
      path.join(archive, physical.nameOf(own.other)),
    );
    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.nearer),
      target: physical.nameOf(own.near),
    });
    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.ancestor),
      target: physical.nameOf(own.far),
    });
    await expect(readFile(copiedTarget)).resolves.toStrictEqual(await readFile(own.target));
  });

  it('skips an empty nearer subpath directory with no main or index', async () => {
    const own = await fixture();
    await mkdir(path.join(own.near, 'addon'));
    const physical = await nodePhysicalFiles(
      input(own.entry, [own.entry, own.other, own.target]),
      [],
    );
    const archive = await stage(physical);
    const copiedEntry = path.join(archive, physical.nameOf(own.entry));

    expect(createRequire(copiedEntry).resolve(own.requested)).toBe(
      path.join(archive, physical.nameOf(own.target)),
    );
  });

  it('does not consult the nearer root main when resolving an absent legacy subpath', async () => {
    const own = await fixture();
    await writeFile(path.join(own.near, 'package.json'), '{"main":"./missing.cjs"}');
    const physical = await nodePhysicalFiles(
      input(own.entry, [own.entry, own.other, own.target]),
      [],
    );
    const archive = await stage(physical);
    const copiedEntry = path.join(archive, physical.nameOf(own.entry));

    expect(createRequire(copiedEntry).resolve(own.requested)).toBe(
      path.join(archive, physical.nameOf(own.target)),
    );
  });

  it('refuses the first actual unowned target instead of choosing a closed ancestor', async () => {
    const own = await fixture();
    const first = path.join(own.near, 'addon.js');
    await writeFile(first, 'module.exports="authored untraced winner";');

    expect(createRequire(own.entry).resolve(own.requested)).toBe(first);
    await expect(
      nodePhysicalFiles(input(own.entry, [own.entry, own.other, own.target]), []),
    ).rejects.toThrow('first existing Node package target is outside its closed trace');
  });

  it('propagates an invalid nested main instead of searching the closed ancestor', async () => {
    const own = await fixture();
    const nested = path.join(own.near, 'addon');
    await mkdir(nested);
    await writeFile(path.join(nested, 'package.json'), '{"main":"./missing.cjs"}');

    expect(() => createRequire(own.entry).resolve(own.requested)).toThrow(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    );
    await expect(
      nodePhysicalFiles(input(own.entry, [own.entry, own.other, own.target]), []),
    ).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' });
  });

  it('keeps a nearer package exports boundary sealed', async () => {
    const own = await fixture();
    await writeFile(path.join(own.near, 'package.json'), '{"exports":{"./other":"./other.js"}}');

    expect(() => createRequire(own.entry).resolve(own.requested)).toThrow(
      expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
    );
    await expect(
      nodePhysicalFiles(input(own.entry, [own.entry, own.other, own.target]), []),
    ).rejects.toThrow('unproved export or physical topology');
  });

  it('does not acquire an ancestor alias past a missing exported target', async () => {
    const own = await fixture();
    await writeFile(
      path.join(own.near, 'package.json'),
      '{"exports":{"./addon":"./missing.cjs","./other":"./other.js"}}',
    );
    const physical = await nodePhysicalFiles(
      input(own.entry, [own.entry, own.other, own.target]),
      [],
    );

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.nearer),
      target: physical.nameOf(own.near),
    });
    expect(physical.links.some((link) => link.path === physical.nameOf(own.ancestor))).toBe(false);
  });

  it('keeps ESM on its first selected directory even when its requested file is absent', async () => {
    const own = await fixture('dep', true);
    const physical = await nodePhysicalFiles(
      input(own.entry, [own.entry, own.other, own.target]),
      [],
    );

    expect(physical.links).toContainEqual({
      path: physical.nameOf(own.nearer),
      target: physical.nameOf(own.near),
    });
    expect(physical.links.some((link) => link.path === physical.nameOf(own.ancestor))).toBe(false);
  });

  it('retains the selected ancestor subpath directory symlink and its index', async () => {
    const own = await fixture();
    await rm(path.join(own.far, 'addon.js'));
    const nested = path.join(own.far, 'build/nested');
    await mkdir(nested);
    const target = path.join(nested, 'index.js');
    await writeFile(target, 'module.exports="authored directory bytes";');
    await symlink('./build/nested', path.join(own.far, 'addon'));
    const physical = await nodePhysicalFiles(input(own.entry, [own.entry, own.other, target]), []);
    const archive = await stage(physical);
    const copiedEntry = path.join(archive, physical.nameOf(own.entry));

    expect(createRequire(copiedEntry).resolve(own.requested)).toBe(
      path.join(archive, physical.nameOf(target)),
    );
    expect(physical.links).toContainEqual({
      path: physical.nameOf(path.join(own.far, 'addon')),
      target: physical.nameOf(nested),
    });
  });
});
