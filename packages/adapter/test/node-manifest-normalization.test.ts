import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeManifestNormalization } from '../src/node-manifest-normalization.ts';

describe('complete SDK normalization inventory', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-entry-alias-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    file = path.join(directory, 'error.js');
    await writeFile(file, 'module.exports={};');
    await writeFile(path.join(directory, 'other.js'), 'module.exports={};');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps every distinct route ID even when error entries share one physical module', async () => {
    const entries = ['/404', '/500', '/_error'].map((id) => ({ id, filePath: file }));
    const normalized = await nodeManifestNormalization({ entries, distDir: directory });

    expect(normalized.entries).toStrictEqual(
      entries.map((entry) => ({ ...entry, canonicalFilePath: file })),
    );
    expect(Object.isFrozen(normalized.entries)).toBe(true);
    expect(normalized.entries.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('preserves logical paths and input order for a symlink to the same module', async () => {
    const alias = path.join(directory, 'logical.js');
    await symlink(file, alias);
    const normalized = await nodeManifestNormalization({
      entries: [
        { id: '/404', filePath: alias },
        { id: '/_error', filePath: file },
      ],
      distDir: directory,
    });

    expect(normalized.entries).toStrictEqual([
      { id: '/404', filePath: alias, canonicalFilePath: file },
      { id: '/_error', filePath: file, canonicalFilePath: file },
    ]);
  });

  it.each(['error.js', 'other.js'])(
    'still rejects duplicate route IDs for a different physical path: %s',
    async (name) => {
      const other = path.join(directory, name);

      await expect(
        nodeManifestNormalization({
          entries: [
            { id: '/404', filePath: file },
            { id: '/404', filePath: other },
          ],
          distDir: directory,
        }),
      ).rejects.toThrow('duplicate sealed route');
    },
  );

  it('requires every shared entry to resolve to an existing physical file', async () => {
    await expect(
      nodeManifestNormalization({
        entries: [
          { id: '/404', filePath: file },
          { id: '/_error', filePath: path.join(directory, 'missing.js') },
        ],
        distDir: directory,
      }),
    ).rejects.toThrow(/ENOENT/u);
  });
});
