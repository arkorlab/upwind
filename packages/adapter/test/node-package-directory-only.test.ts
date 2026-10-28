import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import { nodePackageLegacySubpath } from '../src/node-package-lookup.ts';
import { nodePackageSubpaths } from '../src/node-package-subpaths.ts';

describe('closed CommonJS directory-only package lookups', () => {
  let directory: string;
  let project: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-directory-only-');
    directory = await realpath(await mkdtemp(prefix));
    project = path.join(directory, 'app');
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['dep/', 'dep/sub/', '@scope/dep/', '@scope/dep/sub/'])(
    'retains the terminal slash in legacy target DATA: %s',
    (specifier) => {
      const name = specifier.startsWith('@') ? '@scope/dep' : 'dep';

      expect(nodePackageSubpaths(specifier, name, {})).toStrictEqual({
        exact: false,
        targets: [specifier.endsWith('/sub/') ? './sub/' : './'],
      });
    },
  );

  it.each(['dep//', 'dep/sub//', 'dep/../', 'dep/./', 'dep/sub/../'])(
    'keeps ambiguous or escaping legacy paths refused: %s',
    (specifier) => {
      expect(() => nodePackageSubpaths(specifier, 'dep', {})).toThrow('unproved');
    },
  );

  it.each(['dep/', 'dep/sub/'])(
    'does not extend exact export target classification: %s',
    (specifier) => {
      expect(() =>
        nodePackageSubpaths(specifier, 'dep', { exports: { '.': './index.js' } }),
      ).toThrow('unproved');
    },
  );

  it('does not let a same-name file turn an absent trailing-slash directory into a candidate', async () => {
    const dependency = path.join(project, 'node_modules/dep');
    const importer = path.join(project, 'entry.cjs');
    await mkdir(dependency);
    await writeFile(importer, 'module.exports="inert authored source";');
    await writeFile(path.join(dependency, 'sub.js'), 'module.exports="never evaluated";');

    await expect(nodePackageLegacySubpath(importer, dependency, 'dep/sub/', 'dep')).resolves.toBe(
      false,
    );
  });

  it.each(['dep/', 'dep/sub/', '@scope/dep/', '@scope/dep/sub/'])(
    'restores a symlinked directory index without selecting sibling files: %s',
    async (specifier) => {
      const name = specifier.startsWith('@') ? '@scope/dep' : 'dep';
      const dependency = path.join(project, 'store/pkg');
      const subdirectory = specifier.endsWith('/sub/') ? 'sub' : '';
      const selected = path.join(dependency, subdirectory);
      await mkdir(path.join(selected, 'build'), { recursive: true });
      await mkdir(selected, { recursive: true });
      const target = path.join(selected, 'build/selected.js');
      const logical = path.join(selected, 'index.js');
      const entry = path.join(project, 'entry.cjs');
      const packageAlias = path.join(project, 'node_modules', name);
      await mkdir(path.dirname(packageAlias), { recursive: true });
      await writeFile(target, 'module.exports="authored data, never evaluated";');
      await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name }));
      await symlink(path.relative(selected, target), logical);
      await symlink(path.relative(path.dirname(packageAlias), dependency), packageAlias);
      // Both root and subpath have file competitors; the final slash must exclude them.
      await writeFile(`${packageAlias}.js`, 'throw new Error("not selected");');
      await writeFile(path.join(dependency, 'sub.js'), 'throw new Error("not selected");');
      const code = `module.exports=()=>require(${jsLiteral(specifier)});`;
      await writeFile(entry, code);
      const input = {
        repoRoot: directory,
        projectDir: project,
        patch: { distDir: path.join(project, '.next') },
        entries: [{ id: '/authored', filePath: entry }],
        entryTraces: [{ id: '/authored', assets: { [entry]: entry, [target]: target } }],
        files: [],
        edgeEntries: [],
        manifests: [],
      } as unknown as BuildFunctionInput;
      const physical = await nodePhysicalFiles(input, []);
      const archive = path.join(directory, 'archive');
      for (const file of physical.files) {
        const destination = path.join(archive, file.name);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.bytes);
      }
      for (const link of physical.links) {
        const destination = path.join(archive, link.path);
        await mkdir(path.dirname(destination), { recursive: true });
        const relative = path.relative(path.dirname(destination), path.join(archive, link.target));
        await symlink(relative, destination);
      }
      const resolved = createRequire(path.join(archive, physical.nameOf(entry))).resolve(specifier);

      const copiedEntry = path.join(archive, physical.nameOf(entry));

      expect(resolved).toBe(path.join(archive, physical.nameOf(target)));
      await expect(readFile(resolved)).resolves.toStrictEqual(await readFile(target));
      await expect(readFile(copiedEntry, 'utf8')).resolves.toBe(code);
    },
  );
});
