import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { nodeModuleAliases } from '../src/node-module-aliases.ts';
import { nodePackageImportsDirectory } from '../src/node-package-lookup.ts';
import type { NodePhysicalLayout } from '../src/node-physical-layout.ts';

async function link(alias: string, target: string): Promise<void> {
  await mkdir(path.dirname(alias), { recursive: true });
  await symlink(path.relative(path.dirname(alias), target), alias);
}

describe('external package imports use directory lookup without changing load conditions', () => {
  let directory: string;
  let project: string;
  let files: Map<string, Uint8Array>;
  let originals: Map<string, string>;
  let layout: NodePhysicalLayout;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-import-target-');
    directory = await realpath(await mkdtemp(prefix));
    project = path.join(directory, 'app');
    files = new Map();
    originals = new Map();
    const nameOf = (file: string): string => {
      const relative = path.relative(directory, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new AuditError('Node artifact input escapes both its tracing root and build output');
      return path.posix.join('project', relative.split(path.sep).join('/'));
    };
    layout = {
      root: directory,
      traceRoot: directory,
      distDir: undefined,
      cwd: 'project/app',
      nameOf,
    };
    await mkdir(project);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function closed(file: string, source: string, original = true): Promise<string> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
    const name = layout.nameOf(file);
    files.set(name, new TextEncoder().encode(source));
    if (original) originals.set(file, name);
    return file;
  }
  async function fixture(target = 'dep', code = "module.exports=require('#dep');") {
    const filename = code.startsWith('import ') ? 'entry.mjs' : 'entry.cjs';
    const entry = await closed(path.join(project, 'sub', filename), code);
    await closed(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'app', imports: { '#dep': target } }),
      false,
    );
    const dependency = path.join(directory, 'store/dep');
    const main = await closed(
      path.join(dependency, 'index.js'),
      'throw new Error("authored bytes are never executed");',
    );
    await closed(path.join(dependency, 'package.json'), '{"name":"dep","main":"index.js"}', false);
    const alias = path.join(project, 'node_modules/dep');
    await link(alias, dependency);
    return { entry, dependency, main, alias };
  }
  async function aliases(): Promise<Map<string, string>> {
    const links = new Map<string, string>();
    await nodeModuleAliases({ files, originals }, layout, links);
    return links;
  }
  function expected(alias: string, target: string): [string, string] {
    return [layout.nameOf(alias), layout.nameOf(target)];
  }

  it.each(["module.exports=require('#dep');", "import '#dep';"])(
    'ignores untraced dep.js beside the actual mapped package for %s',
    async (code) => {
      const own = await fixture('dep', code);
      await writeFile(`${own.alias}.js`, 'throw new Error("untraced decoy");');
      const before = new Map(files);
      const links = await aliases();

      expect([...links]).toStrictEqual([expected(own.alias, own.dependency)]);
      expect(files).toStrictEqual(before);
      await expect(readFile(own.main, 'utf8')).resolves.toBe(
        'throw new Error("authored bytes are never executed");',
      );
    },
  );

  it('selects scoped external package directories without trying a sibling .js file', async () => {
    const own = await fixture('@scope/dep');
    const scoped = path.join(project, 'node_modules/@scope/dep');
    await link(scoped, own.dependency);
    await writeFile(`${scoped}.js`, 'untraced decoy');

    expect([...(await aliases())]).toStrictEqual([expected(scoped, own.dependency)]);
  });

  it('preserves all existing finite require/import exports branches', async () => {
    const own = await fixture();
    const requireTarget = await closed(path.join(directory, 'store/require.cjs'), 'throw 1;');
    const importTarget = await closed(path.join(directory, 'store/import.mjs'), 'throw 2;');
    await closed(
      path.join(own.dependency, 'package.json'),
      JSON.stringify({ exports: { require: './required.cjs', import: './imported.mjs' } }),
      false,
    );
    await link(path.join(own.dependency, 'required.cjs'), requireTarget);
    await link(path.join(own.dependency, 'imported.mjs'), importTarget);

    expect([...(await aliases())]).toStrictEqual([
      expected(own.alias, own.dependency),
      expected(path.join(own.dependency, 'required.cjs'), requireTarget),
      expected(path.join(own.dependency, 'imported.mjs'), importTarget),
    ]);
  });

  it('keeps mapped root legacy main/index alias proof', async () => {
    const own = await fixture();
    const target = await closed(path.join(directory, 'store/actual.cjs'), 'throw 42;');
    await closed(path.join(own.dependency, 'package.json'), '{"main":"./main"}', false);
    await link(path.join(own.dependency, 'main.js'), target);

    expect([...(await aliases())]).toStrictEqual([
      expected(own.alias, own.dependency),
      expected(path.join(own.dependency, 'main.js'), target),
    ]);
  });

  it('resolves external legacy subpaths as exact files, retaining their aliases', async () => {
    const own = await fixture('dep/feature');
    const target = await closed(path.join(directory, 'store/feature.cjs'), 'throw 42;');
    await link(path.join(own.dependency, 'feature'), target);
    await writeFile(path.join(own.dependency, 'feature.js'), 'untraced decoy');

    expect([...(await aliases())]).toStrictEqual([
      expected(own.alias, own.dependency),
      expected(path.join(own.dependency, 'feature'), target),
    ]);
  });

  it('does not invent a suffix fallback for a mapped external subpath', async () => {
    const own = await fixture('dep/feature');
    await closed(path.join(own.dependency, 'feature.js'), 'throw 42;');

    await expect(aliases()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not fall back to an ancestor after the nearest directory lacks the exact subpath', async () => {
    const own = await fixture('dep/feature.js');
    const far = path.join(directory, 'node_modules/dep');
    await closed(path.join(far, 'feature.js'), 'throw 42;');

    await expect(aliases()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      nodePackageImportsDirectory(path.join(project, 'package.json'), 'dep'),
    ).resolves.toBe(own.alias);
  });

  it('refuses an unowned nearest package directory instead of selecting a closed ancestor', async () => {
    const own = await fixture();
    const unowned = path.join(project, 'sub/node_modules/dep');
    await mkdir(unowned, { recursive: true });
    await writeFile(path.join(unowned, 'index.js'), 'untraced nearer importer shadow');

    // The mapping is resolved from the package scope, so this importer shadow is ignored.
    expect([...(await aliases())]).toStrictEqual([expected(own.alias, own.dependency)]);

    originals.delete(own.main);

    await expect(aliases()).rejects.toThrow('outside its closed trace');
  });

  it('does not use a bare file when no mapped package directory exists', async () => {
    await closed(path.join(project, 'entry.cjs'), "require('#dep');");
    await closed(
      path.join(project, 'package.json'),
      '{"imports":{"#dep":"no-directory-external-target"}}',
      false,
    );
    await closed(path.join(project, 'node_modules/no-directory-external-target.js'), 'throw 42;');

    await expect(aliases()).rejects.toThrow('external alias has no closed physical target');
  });

  it('keeps ordinary bare CommonJS file precedence', async () => {
    const own = await fixture('dep', "module.exports=require('dep');");
    const target = await closed(path.join(directory, 'store/bare.cjs'), 'throw 42;');
    await link(`${own.alias}.js`, target);

    expect([...(await aliases())]).toStrictEqual([expected(`${own.alias}.js`, target)]);
  });

  it('keeps ordinary CommonJS legacy subpath suffix probing', async () => {
    const own = await fixture('dep', "module.exports=require('dep/feature');");
    const target = await closed(path.join(directory, 'store/feature.cjs'), 'throw 42;');
    await link(path.join(own.dependency, 'feature.js'), target);

    expect([...(await aliases())]).toStrictEqual([
      expected(own.alias, own.dependency),
      expected(path.join(own.dependency, 'feature.js'), target),
    ]);
  });

  it('keeps ordinary CommonJS fallback past a nearer package without an entry', async () => {
    const own = await fixture('dep', "module.exports=require('dep');");
    originals.delete(own.main);
    files.delete(layout.nameOf(own.main));
    await rm(own.main);
    await closed(path.join(own.dependency, 'package.json'), '{}', false);
    await closed(path.join(own.dependency, 'other.js'), 'throw 42;');
    const ancestor = path.join(directory, 'node_modules/dep');
    const far = path.join(directory, 'store/far');
    await closed(path.join(far, 'package.json'), '{}', false);
    await closed(path.join(far, 'index.js'), 'throw 43;');
    await link(ancestor, far);

    expect([...(await aliases())]).toStrictEqual([expected(ancestor, far)]);
  });

  it.each(['../escape.cjs', '/outside/escape.cjs'])(
    'keeps mapped root main within its finite package boundary: %s',
    async (main) => {
      const own = await fixture();
      await closed(path.join(own.dependency, 'package.json'), JSON.stringify({ main }), false);

      await expect(aliases()).rejects.toThrow(/escapes|absolute/u);
    },
  );

  it.each(['dep/extra', '../dep', 'node_modules', '@scope/../dep'])(
    'rejects a malformed package-root lookup request %s',
    async (packageName) => {
      await expect(
        nodePackageImportsDirectory(path.join(project, 'package.json'), packageName),
      ).rejects.toThrow('unproved external target');
    },
  );

  it('includes node_modules ancestor steps in mapped directory search', async () => {
    const scope = path.join(project, 'node_modules/owner/package.json');
    const intermediate = path.join(project, 'node_modules/node_modules/dep');
    const farther = path.join(project, 'node_modules/dep');
    await mkdir(intermediate, { recursive: true });
    await mkdir(farther, { recursive: true });

    await expect(nodePackageImportsDirectory(scope, 'dep')).resolves.toBe(intermediate);
  });

  it('propagates nonabsence filesystem failures from mapped lookup', async () => {
    const own = await fixture();
    await rm(own.alias);
    await symlink('dep', own.alias);

    await expect(aliases()).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(nodePackageImportsDirectory(own.entry, 'dep')).rejects.toMatchObject({
      code: 'ELOOP',
    });
  });

  it.each(['dep/../other', 'dep/*', '../dep', '#other', 'dep?x'])(
    'retains finite external target refusal for %s',
    async (target) => {
      await fixture(target);

      await expect(aliases()).rejects.toThrow(/unproved external|literal target/u);
    },
  );

  it.each([{ '#*': 'dep' }, { '#dep': { require: 'dep' } }])(
    'does not expand unsupported imports mappings %j',
    async (imports) => {
      await fixture();
      await closed(path.join(project, 'package.json'), JSON.stringify({ imports }), false);

      await expect(aliases()).rejects.toThrow(/proved exact mapping|literal target/u);
    },
  );
});
