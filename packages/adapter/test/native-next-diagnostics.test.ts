import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { retainNativeNextDiagnostics } from '../../../tools/native-addon-next-diagnostics.mts';

const roots: string[] = [];
const FILE_LIMIT = 16_777_216;
const COUNT_LIMIT = 256;

async function fixture(): Promise<{
  readonly root: string;
  readonly fixture: string;
  readonly server: string;
  readonly output: string;
}> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'native-next-diagnostic-test-'));
  const root = await realpath(temporary);
  roots.push(root);
  const directory = await mkdtemp(path.join(root, 'upwind-native-next-'));
  const fixturePath = path.join(directory, 'fixture');
  const server = path.join(fixturePath, '.next/server');
  await mkdir(server, { recursive: true });
  return {
    root,
    fixture: fixturePath,
    server,
    output: path.join(root, 'upwind-native-next-diagnostics'),
  };
}

// The CI control is Linux-only; directory-FD traversal relies on its kernel's /proc/self/fd.
describe.runIf(process.platform === 'linux')('fixed public native fixture diagnostics', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('copies only compiled pages and chunks without manifests, root data, links or binary payloads', async () => {
    const own = await fixture();
    const code = 'exports.publicFixture=42;\n';
    await mkdir(path.join(own.server, 'chunks'));
    await mkdir(path.join(own.server, 'pages/blog'), { recursive: true });
    await mkdir(path.join(own.server, 'app'));
    await writeFile(path.join(own.server, 'chunks/ordinary.js'), code);
    await writeFile(path.join(own.server, 'pages/blog/[slug].js'), code);
    await writeFile(path.join(own.server, 'root.js'), 'not retained');
    await writeFile(path.join(own.server, 'app/ordinary.js'), 'not retained');
    for (const relative of [
      'server-reference-manifest.js',
      'chunks/server-reference-manifest.js',
      'pages/pages-manifest.js',
      'pages/blog/server-reference-manifest.js',
    ])
      await writeFile(path.join(own.server, relative), 'exports.key="inert-build-metadata";');
    await writeFile(path.join(own.server, 'chunks/chunk.js.map'), '{"source":"not retained"}');
    await writeFile(path.join(own.server, 'chunks/addon.node'), 'not retained');
    await writeFile(path.join(own.server, 'chunks/archive.tar.gz'), 'not retained');
    await writeFile(path.join(own.server, 'chunks/.env'), 'not retained');
    await writeFile(path.join(own.server, 'chunks/binary.js'), Buffer.from([0x7f, 0x45, 0]));
    await writeFile(
      path.join(own.server, 'chunks/inline-map.js'),
      '//# sourceMappingURL=data:application/json,{}',
    );
    await writeFile(path.join(own.fixture, 'outside.js'), 'not retained');
    await symlink(path.join(own.fixture, 'outside.js'), path.join(own.server, 'chunks/linked.js'));
    await symlink(own.fixture, path.join(own.server, 'chunks/linked-directory'), 'dir');
    await link(
      path.join(own.fixture, 'outside.js'),
      path.join(own.server, 'chunks/hard-linked.js'),
    );

    const result = await retainNativeNextDiagnostics(own.fixture, own.root);
    const outputNames = await readdir(own.output);

    expect(result.files).toBe(2);
    expect(result.bytes).toBe(Buffer.byteLength(code) * 2);
    expect(outputNames.toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
      'chunks',
      'pages',
    ]);
    await expect(readFile(path.join(own.output, 'chunks/ordinary.js'), 'utf8')).resolves.toBe(code);
    await expect(readFile(path.join(own.output, 'pages/blog/[slug].js'), 'utf8')).resolves.toBe(
      code,
    );
    await expect(readdir(path.join(own.output, 'chunks'))).resolves.toStrictEqual(['ordinary.js']);
    await expect(readdir(path.join(own.output, 'pages'))).resolves.toStrictEqual(['blog']);
    await expect(readdir(path.join(own.output, 'pages/blog'))).resolves.toStrictEqual([
      '[slug].js',
    ]);
  });

  it('never follows a symlinked server root', async () => {
    const own = await fixture();
    await rm(own.server, { recursive: true });
    await symlink(own.fixture, own.server, 'dir');

    await expect(retainNativeNextDiagnostics(own.fixture, own.root)).rejects.toThrow(
      /ELOOP|ENOTDIR/u,
    );
    await expect(readdir(own.root)).resolves.not.toContain('upwind-native-next-diagnostics');
  });

  it('never follows a replaced temporary fixture parent', async () => {
    const own = await fixture();
    const parent = path.dirname(own.fixture);
    const outside = path.join(own.root, 'outside');
    await rename(parent, outside);
    await symlink(outside, parent, 'dir');

    await expect(retainNativeNextDiagnostics(own.fixture, own.root)).rejects.toThrow(
      /ELOOP|ENOTDIR/u,
    );
    await expect(readdir(own.root)).resolves.not.toContain('upwind-native-next-diagnostics');
  });

  it('refuses an existing destination without writing through its symlink', async () => {
    const own = await fixture();
    const outside = path.join(own.root, 'outside');
    await mkdir(outside);
    await mkdir(path.join(own.server, 'chunks'));
    await writeFile(path.join(own.server, 'chunks/ordinary.js'), 'exports.publicFixture=42;');
    await symlink(outside, own.output, 'dir');

    await expect(retainNativeNextDiagnostics(own.fixture, own.root)).rejects.toThrow('EEXIST');
    await expect(readdir(outside)).resolves.toStrictEqual([]);
  });

  it('bounds the retained file count', async () => {
    const own = await fixture();
    const chunks = path.join(own.server, 'chunks');
    await mkdir(chunks);
    for (let index = 0; index <= COUNT_LIMIT; index += 1)
      await writeFile(path.join(chunks, `ordinary-${index}.js`), 'exports.publicFixture=42;');

    const result = await retainNativeNextDiagnostics(own.fixture, own.root);

    expect(result.files).toBe(COUNT_LIMIT);
    expect(result.truncated).toBe(true);
    await expect(readdir(path.join(own.output, 'chunks'))).resolves.toHaveLength(COUNT_LIMIT);
  });

  it('refuses an oversized source before allocating or reading its bytes', async () => {
    const own = await fixture();
    const chunks = path.join(own.server, 'chunks');
    await mkdir(chunks);
    const oversized = path.join(chunks, 'oversized.js');
    await writeFile(oversized, '');
    await truncate(oversized, FILE_LIMIT + 1);
    await writeFile(path.join(chunks, 'ordinary.js'), 'exports.publicFixture=42;');

    const result = await retainNativeNextDiagnostics(own.fixture, own.root);

    expect(result.files).toBe(1);
    expect(result.truncated).toBe(true);
    await expect(readdir(path.join(own.output, 'chunks'))).resolves.toStrictEqual(['ordinary.js']);
  });

  it('refuses a source outside the control-owned temporary fixture shape', async () => {
    const own = await fixture();

    await expect(retainNativeNextDiagnostics(own.server, own.root)).rejects.toThrow(
      'temporary fixture',
    );
  });
});
