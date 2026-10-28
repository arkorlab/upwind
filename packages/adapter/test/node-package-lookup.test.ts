import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  nodePackageCandidate,
  nodePackageDirectory,
  nodePackageHasExports,
  nodePackageLegacySubpath,
} from '../src/node-package-lookup.ts';

describe('inert legacy package subpath lookup data', () => {
  let directory: string;
  let importer: string;
  let dependency: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'node-package-lookup-');
    directory = await realpath(await mkdtemp(prefix));
    importer = path.join(directory, 'entry.cjs');
    dependency = path.join(directory, 'node_modules/dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(importer, 'module.exports="authored inert bytes";');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function selected(specifier = 'dep/addon'): Promise<boolean> {
    return nodePackageLegacySubpath(importer, dependency, specifier, 'dep');
  }

  function rootSelected(): Promise<boolean> {
    return nodePackageCandidate(importer, dependency, { specifier: 'dep', kind: 'require' }, 'dep');
  }

  it.each([{}, { main: '' }, { main: false }, { main: 0 }, { main: null }])(
    'keeps a root without main/index absent for %j',
    async (metadata) => {
      await writeFile(path.join(dependency, 'package.json'), JSON.stringify(metadata));
      await writeFile(path.join(dependency, 'other.js'), 'never executed');

      await expect(rootSelected()).resolves.toBe(false);
    },
  );

  it.each(['.js', '.json', '.node'])(
    'recognizes a root index%s after bare file candidates were considered',
    async (suffix) => {
      await writeFile(path.join(dependency, `index${suffix}`), 'never executed');

      await expect(rootSelected()).resolves.toBe(true);
    },
  );

  it('propagates an invalid truthy root main instead of calling it absent', async () => {
    await writeFile(path.join(dependency, 'package.json'), '{"main":"./missing.cjs"}');

    await expect(rootSelected()).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' });
  });

  it.each(['../escape.cjs', '/outside/escape.cjs'])(
    'keeps the existing finite main boundary for %s',
    async (main) => {
      await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ main }));

      await expect(rootSelected()).rejects.toThrow(/escapes|absolute/u);
    },
  );

  it.each(['', '.js', '.json', '.node'])(
    'recognizes the existing %s file without loading its bytes',
    async (suffix) => {
      await writeFile(path.join(dependency, `addon${suffix}`), 'never executed');

      await expect(selected()).resolves.toBe(true);
    },
  );

  it.each(['.js', '.json', '.node'])(
    'recognizes the nested directory index%s without loading its bytes',
    async (suffix) => {
      const nested = path.join(dependency, 'addon');
      await mkdir(nested);
      await writeFile(path.join(nested, `index${suffix}`), 'never executed');

      await expect(selected()).resolves.toBe(true);
    },
  );

  it('keeps a missing subpath distinct from an existing package root', async () => {
    await writeFile(path.join(dependency, 'other.js'), 'never executed');

    await expect(selected()).resolves.toBe(false);
  });

  it('does not consider an extensionless index a directory entrypoint', async () => {
    const nested = path.join(dependency, 'addon');
    await mkdir(nested);
    await writeFile(path.join(nested, 'index'), 'never executed');

    await expect(selected()).resolves.toBe(false);
  });

  it('resolves a genuine nested main without evaluating its module', async () => {
    const nested = path.join(dependency, 'addon');
    await mkdir(nested);
    await writeFile(path.join(nested, 'package.json'), '{"main":"./entry.cjs"}');
    await writeFile(path.join(nested, 'entry.cjs'), 'throw new Error("never executed");');

    await expect(selected()).resolves.toBe(true);
  });

  it('propagates a broken nested main instead of converting MODULE_NOT_FOUND into absence', async () => {
    const nested = path.join(dependency, 'addon');
    await mkdir(nested);
    await writeFile(path.join(nested, 'package.json'), '{"main":"./missing.cjs"}');

    await expect(selected()).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' });
  });

  it('propagates malformed nested package metadata', async () => {
    const nested = path.join(dependency, 'addon');
    await mkdir(nested);
    await writeFile(path.join(nested, 'package.json'), '{"main":');

    await expect(selected()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('propagates nonabsence filesystem errors for every package lookup helper', async () => {
    const loop = path.join(directory, 'loop');
    await symlink('loop', loop);

    await expect(nodePackageDirectory(loop)).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(nodePackageHasExports(loop)).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(
      nodePackageLegacySubpath(importer, loop, 'dep/addon', 'dep'),
    ).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it.each([null, {}, { './addon': './other.js' }])(
    'preserves the existing nonnull exports detection for %j',
    async (exports) => {
      await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ exports }));

      await expect(nodePackageHasExports(dependency)).resolves.toBe(exports !== null);
    },
  );

  it('keeps the ESM directory-only predicate distinct from a regular file', async () => {
    const file = path.join(directory, 'plain.cjs');
    await writeFile(file, 'never executed');

    await expect(nodePackageDirectory(dependency)).resolves.toBe(true);
    await expect(nodePackageDirectory(file)).resolves.toBe(false);
    await expect(nodePackageDirectory(path.join(directory, 'missing'))).resolves.toBe(false);
  });

  it.each(['dep/../other', 'dep/addon//', 'dep/addon?x', 'dep/addon#x', 'dep/%61ddon'])(
    'refuses the existing unsupported relative subpath boundary %s',
    async (specifier) => {
      await expect(selected(specifier)).rejects.toThrow('unproved export or physical topology');
    },
  );
});
