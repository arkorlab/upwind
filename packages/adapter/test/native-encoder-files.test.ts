import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { imageEncoderFiles } from '../src/native/encoder-files.ts';
import { copyNativeFiles } from '../src/native/files.ts';

/**
 * The image encoder an artifact carries: `sharp` as Next.js finds it, with what it requires — here,
 * this package's own Next.js development dependency stands for an application's installation.
 */

const run = promisify(execFile);
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE_DIR = path.resolve(PACKAGE_DIR, '../..');
/**
 * A load of `sharp` from where Next.js is, and one image made with it — what the server does — said
 * back with where the `sharp` loaded is.
 */
const LOAD_AND_ENCODE = [
  "const { createRequire } = require('node:module');",
  'const from = createRequire(process.argv[1]);',
  "const sharp = from('sharp');",
  "sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer()",
  "  .then((bytes) => process.stdout.write(JSON.stringify({ at: from.resolve('sharp'), bytes: bytes.byteLength })));",
].join('\n');
const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-encoder-files-'));
  directories.push(directory);
  return directory;
}

describe('the image encoder an artifact carries', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('lists sharp by the path Next.js reaches it at, with the binding for this platform', async () => {
    const files = await imageEncoderFiles(PACKAGE_DIR);
    const nextDir = path.dirname(
      createRequire(path.join(PACKAGE_DIR, 'package.json')).resolve('next/package.json'),
    );

    expect(files).toContain(path.join(path.dirname(nextDir), 'sharp', 'package.json'));
    expect(files.some((file) => file.endsWith('.node'))).toBe(true);
    expect(files.some((file) => file.includes(`${path.sep}@img${path.sep}colour${path.sep}`))).toBe(
      true,
    );
  });

  it('lists nothing where the Next.js installed has no sharp beside it', async () => {
    const project = await temporary();
    await mkdir(path.join(project, 'node_modules/next'), { recursive: true });
    await writeFile(path.join(project, 'package.json'), '{"name":"project"}');
    await writeFile(path.join(project, 'node_modules/next/package.json'), '{"name":"next"}');

    await expect(imageEncoderFiles(project)).resolves.toStrictEqual([]);
  });

  it('copies into an artifact that loads it and encodes, away from the installation', async () => {
    const output = await temporary();
    const nextManifest = createRequire(path.join(PACKAGE_DIR, 'package.json')).resolve(
      'next/package.json',
    );
    const files = [nextManifest, ...(await imageEncoderFiles(PACKAGE_DIR))];

    const { pathOf } = await copyNativeFiles({
      files,
      directories: [WORKSPACE_DIR],
      outDir: output,
    });
    const copiedNext = path.join(output, pathOf(nextManifest));
    // Nothing of the installation's to fall back on: no `NODE_PATH`, which a package manager sets.
    const env = { ...process.env };
    delete env['NODE_PATH'];
    const { stdout } = await run(process.execPath, ['-e', LOAD_AND_ENCODE, copiedNext], {
      cwd: output,
      env,
    });
    const loaded = JSON.parse(stdout) as { readonly at: string; readonly bytes: number };

    expect(loaded.at.startsWith(await realpath(output))).toBe(true);
    expect(loaded.bytes).toBeGreaterThan(0);
  });
});
