import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { copyNativeFiles, nativeAssetSources, nativeTraceFiles } from '../src/native/files.ts';

const run = promisify(execFile);
const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-native-files-'));
  directories.push(directory);
  return directory;
}

async function file(directory: string, name: string, contents: string): Promise<string> {
  const location = path.join(directory, name);
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, contents);
  return location;
}

describe('native dependency files', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('relocates an NFT-discovered package alias across additional roots and runs it without the originals', async () => {
    const root = await temporary();
    const project = path.join(root, 'project');
    const store = path.join(root, 'store/example');
    const output = path.join(root, 'output');
    const moved = path.join(root, 'moved');
    const entry = await file(
      project,
      '.next/server/entry.cjs',
      'module.exports = require("example-native-alias")',
    );
    await file(
      store,
      'index.cjs',
      'module.exports = require("node:fs").readFileSync(require("node:path").join(__dirname,"message.txt"),"utf8")',
    );
    await file(store, 'package.json', '{"name":"example","main":"index.cjs"}');
    await file(store, 'message.txt', 'native package data');
    const license = await file(store, 'LICENSE', 'example package license');
    const link = path.join(project, '.next/node_modules/example-native-alias');
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(path.relative(path.dirname(link), store), link, 'dir');
    const trace = await file(
      project,
      '.next/server/entry.cjs.nft.json',
      JSON.stringify({
        version: 1,
        files: ['../node_modules/example-native-alias'],
        symlinks: [[0, '.', 0]],
        additionalRoots: [
          {
            name: 'package-store',
            path: '../../../store/example',
            files: ['index.cjs', 'package.json', 'message.txt'],
          },
        ],
      }),
    );
    const traced = await nativeTraceFiles(trace);
    const layout = await copyNativeFiles({
      files: [entry, ...traced],
      directories: [project],
      outDir: output,
    });
    await rename(output, moved);
    await rm(project, { recursive: true, force: true });
    await rm(path.join(root, 'store'), { recursive: true, force: true });
    const result = await run(
      process.execPath,
      ['-e', 'process.stdout.write(require(process.argv[1]))', `./${layout.pathOf(entry)}`],
      { cwd: moved },
    );

    expect(result.stdout).toBe('native package data');

    const copiedLicense = path.join(moved, layout.pathOf(license));

    await expect(readFile(copiedLicense, 'utf8')).resolves.toBe('example package license');
  });

  it("copies a cross-root link from its trace, not the link Next.js stages for the output's destinations", async () => {
    const root = await temporary();
    const project = path.join(root, 'project');
    const distDir = path.join(project, '.next');
    const external = path.join(root, 'additional-root');
    const output = path.join(root, 'output');
    const moved = path.join(root, 'moved');
    const entry = await file(
      distDir,
      'server/app/page.cjs',
      'module.exports = require("sibling-0123456789abcdef")',
    );
    await file(external, 'node_modules/sibling/index.cjs', 'module.exports = "sibling value"');
    await file(
      external,
      'node_modules/sibling/package.json',
      '{"name":"sibling","main":"index.cjs"}',
    );
    // Turbopack's link to the external package, in the additional root, as the trace lists it.
    const link = path.join(distDir, 'node_modules/sibling-0123456789abcdef');
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(
      path.relative(path.dirname(link), path.join(external, 'node_modules/sibling')),
      link,
      'dir',
    );
    // The same link as Next.js stages it for the output, relative to the destination's directory.
    const staged = path.join(
      distDir,
      'adapter/synthetic_symlinks/6c7ddb056aa2722a836933f182e0daed',
    );
    await mkdir(path.dirname(staged), { recursive: true });
    await symlink('../../next_additional_roots/linkedPackages/node_modules/sibling', staged, 'dir');
    const externalFromTrace = path.relative(path.join(distDir, 'server/app'), external);
    const trace = await file(
      distDir,
      'server/app/page.cjs.nft.json',
      JSON.stringify({
        version: 1,
        files: ['../../node_modules/sibling-0123456789abcdef'],
        symlinks: [[0, 'node_modules/sibling', 0]],
        additionalRoots: [
          {
            name: 'linkedPackages',
            path: externalFromTrace,
            files: ['node_modules/sibling/index.cjs', 'node_modules/sibling/package.json'],
          },
        ],
      }),
    );
    const assets = {
      '.next/node_modules/sibling-0123456789abcdef': staged,
      'next_additional_roots/linkedPackages/node_modules/sibling/index.cjs': path.join(
        external,
        'node_modules/sibling/index.cjs',
      ),
    };
    const traced = await nativeTraceFiles(trace);

    await expect(
      copyNativeFiles({
        files: [entry, ...Object.values(assets), ...traced],
        directories: [project],
        outDir: path.join(root, 'refused'),
      }),
    ).rejects.toHaveProperty('code', 'ENOENT');

    const layout = await copyNativeFiles({
      files: [entry, ...nativeAssetSources(assets, distDir), ...traced],
      directories: [project],
      outDir: output,
    });

    const copiedStaged = path.join(output, layout.pathOf(staged));

    await expect(lstat(copiedStaged)).rejects.toHaveProperty('code', 'ENOENT');

    await rename(output, moved);
    await rm(project, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
    const result = await run(
      process.execPath,
      ['-e', 'process.stdout.write(require(process.argv[1]))', `./${layout.pathOf(entry)}`],
      { cwd: moved },
    );

    expect(result.stdout).toBe('sibling value');
  });

  it('keeps explicit environment files out of the relocatable artifact', async () => {
    const root = await temporary();
    const source = await file(root, 'project/.env.production', 'PRIVATE_TOKEN=private');
    const output = path.join(root, 'output');
    const layout = await copyNativeFiles({
      files: [source],
      directories: [path.join(root, 'project')],
      outDir: output,
    });
    const copied = path.join(output, layout.pathOf(source));

    await expect(readFile(copied, 'utf8')).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('refuses retained Cloudflare module imports', async () => {
    const root = await temporary();
    const source = await file(
      root,
      'project/entry.mjs',
      'import { env } from "cloudflare:workers"; export { env };',
    );

    await expect(
      copyNativeFiles({ files: [source], directories: [root], outDir: path.join(root, 'output') }),
    ).rejects.toThrow('Cloudflare-only');
  });

  it('reads legacy NFT files and additional roots, rejecting escapes from an additional root', async () => {
    const root = await temporary();
    const trace = await file(
      root,
      'project/entry.nft.json',
      JSON.stringify({
        files: ['entry.js'],
        additionalRoots: [{ name: 'shared', path: '../../shared', files: ['data.json'] }],
      }),
    );

    await expect(nativeTraceFiles(trace)).resolves.toStrictEqual([
      path.join(root, 'project/entry.js'),
      path.resolve(root, '../shared/data.json'),
    ]);

    await writeFile(
      trace,
      JSON.stringify({
        files: [],
        additionalRoots: [{ name: 'shared', path: '../../shared', files: ['../secret'] }],
      }),
    );

    await expect(nativeTraceFiles(trace)).rejects.toThrow('escapes');
  });
});
