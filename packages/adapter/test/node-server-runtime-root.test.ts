import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertServerRuntimeRoot } from '../src/node-function.ts';

const directories: string[] = [];

/** A distDir whose Turbopack runtime finds the project one directory up, as Next.js writes it. */
async function dist(): Promise<{ root: string; dist: string }> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-runtime-root-'));
  const root = await realpath(temporary);
  directories.push(root);
  const own = path.join(root, '.next');
  const runtime = path.join(own, 'server/chunks/ssr/[turbopack]_runtime.js');
  await mkdir(path.dirname(runtime), { recursive: true });
  await writeFile(
    runtime,
    `var RUNTIME_PUBLIC_PATH = "server/chunks/ssr/[turbopack]_runtime.js";\nvar RELATIVE_ROOT_PATH = "..";\n`,
  );
  return { root, dist: own };
}

describe('the Turbopack runtime root of an artifact carrying the whole server output', () => {
  afterEach(async () => {
    for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('accepts a layout that keeps distDir and the project where they were', async () => {
    const own = await dist();
    const nameOf = (file: string) => `project/${path.relative(own.root, file)}`;

    await expect(assertServerRuntimeRoot(own.dist, nameOf)).resolves.toBeUndefined();
  });

  it('refuses a layout that moves distDir away from the project', async () => {
    const own = await dist();
    const nameOf = (file: string) => {
      return file.startsWith(own.dist)
        ? `.upwind-build/next/${path.relative(own.dist, file)}`
        : `project/${path.relative(own.root, file)}`;
    };

    await expect(assertServerRuntimeRoot(own.dist, nameOf)).rejects.toThrow(
      'relocation changes the Turbopack runtime root',
    );
  });

  it('refuses a runtime that does not declare its root', async () => {
    const own = await dist();
    await writeFile(path.join(own.dist, 'server/chunks/ssr/[turbopack]_runtime.js'), 'var x = 1;');

    await expect(assertServerRuntimeRoot(own.dist, (file) => file)).rejects.toThrow(
      'does not declare its relative project root',
    );
  });
});
