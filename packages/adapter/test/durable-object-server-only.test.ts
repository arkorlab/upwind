import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { bundleDurableObjects } from '../src/durable-objects.ts';

/**
 * `server-only` in a class module's bundle: an empty module, as in Next.js's server bundles,
 * whatever imports it and whether or not the package is installed.
 */

const THROW_MARKER = 'It should only be used from a Server Component';
// eslint-disable-next-line unicorn/no-keyword-prefix -- Exercises the public registration field.
const declaration = { name: 'COUNTERS', module: 'counter.ts', className: 'Counter' };

/** A project whose class module imports `./db.ts`, which imports `server-only`. */
async function project(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), 'upwind-server-only-'));
  const directory = await realpath(made);
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const all: Record<string, string> = {
    'counter.ts': [
      "import { rows } from './db.ts';",
      'export class Counter { count() { return rows.length; } }',
      '',
    ].join('\n'),
    'db.ts': "import 'server-only';\nexport const rows = [1, 2, 3];\n",
    ...files,
  };
  for (const [name, source] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), source);
  }
  return directory;
}

/** The package as Next.js ships its own copy: empty under `react-server`, a throw otherwise. */
const NEXT_SHAPED: Readonly<Record<string, string>> = {
  'node_modules/server-only/package.json': JSON.stringify({
    name: 'server-only',
    exports: { '.': { 'react-server': './empty.js', default: './index.js' } },
  }),
  'node_modules/server-only/empty.js': '',
  'node_modules/server-only/index.js': `throw new Error(${JSON.stringify(
    `This module cannot be imported from a Client Component module. ${THROW_MARKER}.`,
  )});\n`,
};

describe('server-only in a class module’s bundle', () => {
  it('bundles where the package is not installed', async () => {
    const [bundled] = await bundleDurableObjects(await project(), [declaration]);

    expect(bundled?.source).toContain('rows');
    expect(bundled?.source).not.toContain('server-only');
  });

  it('is empty where the package is installed, though its entry throws', async () => {
    const directory = await project(NEXT_SHAPED);
    const watched: string[] = [];
    const [bundled] = await bundleDurableObjects(directory, [declaration], {
      onSourceFile: (file) => {
        watched.push(file);
      },
    });

    expect(bundled?.source).not.toContain(THROW_MARKER);
    // The package's files cannot change the bundle, so the restart watch is told of none of them.
    expect(watched).not.toContainEqual(
      expect.stringContaining(path.join('node_modules', 'server-only')),
    );
    expect(bundled?.inputs).not.toContain(
      path.join(directory, 'node_modules/server-only/index.js'),
    );
    expect(bundled?.inputs.every((file) => path.isAbsolute(file))).toBe(true);
  });

  it('is empty when a package imports it', async () => {
    const directory = await project({
      ...NEXT_SHAPED,
      'db.ts': "import { rows } from 'guarded';\nexport { rows };\n",
      'node_modules/guarded/package.json': JSON.stringify({ name: 'guarded', main: './index.js' }),
      'node_modules/guarded/index.js': "require('server-only');\nexports.rows = [1];\n",
    });
    const [bundled] = await bundleDurableObjects(directory, [declaration]);

    expect(bundled?.source).not.toContain(THROW_MARKER);
  });

  it('leaves client-only to the resolver', async () => {
    const directory = await project({
      'db.ts': "import 'client-only';\nexport const rows = [1];\n",
    });

    await expect(bundleDurableObjects(directory, [declaration])).rejects.toThrow(
      /cannot be resolved/u,
    );
  });
});
