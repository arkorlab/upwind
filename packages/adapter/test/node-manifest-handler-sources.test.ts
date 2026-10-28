import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertCurrentNodeManifestHandlerDirectory,
  assertCurrentNodeManifestHandlerFiles,
  checkedNodeManifestHandlerDirectory,
  checkedNodeManifestHandlerFile,
  nodeManifestHandlerOrigin,
} from '../src/node-manifest-handler-sources.ts';

describe('bounded handler provenance source files', () => {
  let directory: string;
  const code = 'module.exports="authored inert source";';
  const sha256 = createHash('sha256').update(code).digest('hex');

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'handler-provenance-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('seals a regular canonical source and rechecks its original bytes and inode', async () => {
    const file = path.join(directory, 'source.js');
    await writeFile(file, code);
    const original = await checkedNodeManifestHandlerFile(file, sha256);

    await expect(assertCurrentNodeManifestHandlerFiles([original])).resolves.toBeUndefined();
    expect(original).not.toHaveProperty('role');
  });

  it('rejects an equal-byte replacement after the original source was sealed', async () => {
    const file = path.join(directory, 'source.js');
    await writeFile(file, code);
    const original = await checkedNodeManifestHandlerFile(file, sha256);
    await rename(file, path.join(directory, 'old.js'));
    await writeFile(file, code);

    await expect(assertCurrentNodeManifestHandlerFiles([original])).rejects.toThrow(
      'source file replaced',
    );
  });

  it('rejects changed bytes and source symlinks', async () => {
    const file = path.join(directory, 'source.js');
    await writeFile(file, code);
    const alias = path.join(directory, 'alias.js');
    await symlink(file, alias);

    await expect(checkedNodeManifestHandlerFile(alias, sha256)).rejects.toThrow(
      'regular bounded source identity',
    );

    await writeFile(file, 'changed;');

    await expect(checkedNodeManifestHandlerFile(file, sha256)).rejects.toThrow(
      'source bytes changed',
    );
  });

  it('rejects a Next root directory replacement independently of file-content evidence', async () => {
    const root = path.join(directory, 'next');
    await mkdir(root);
    const original = await checkedNodeManifestHandlerDirectory(root);
    await rename(root, path.join(directory, 'previous-next'));
    await mkdir(root);

    await expect(assertCurrentNodeManifestHandlerDirectory(original)).rejects.toThrow(
      'Next directory replaced',
    );
  });

  it.each([
    '../outside.js',
    '/absolute.js',
    'dist/../outside.js',
    String.raw`dist\source.js`,
    'dist//source.js',
    'dist/source.js\0',
  ])('rejects the unqualified origin %s', (relative) => {
    expect(() => nodeManifestHandlerOrigin(directory, relative)).toThrow('source origin');
  });
});
