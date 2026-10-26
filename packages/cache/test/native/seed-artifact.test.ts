/* eslint-disable security/detect-non-literal-fs-filename -- Every path belongs to this suite's private temporary fixture directory. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CACHE_VARS } from '../../src/env.ts';
import { readSeedArtifact, validateSeedArtifact } from '../../src/native/seed-artifact.ts';

const directories: string[] = [];
const maximum = DEFAULT_CACHE_VARS.MAX_ARTIFACT_BYTES;

async function directory(): Promise<string> {
  const location = await mkdtemp(path.join(tmpdir(), 'upwind-seed-artifact-'));
  directories.push(location);
  return location;
}

describe('native seed artifact reads', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((location) => rm(location, { recursive: true, force: true })),
    );
  });

  it('reads a digest-named regular file of its declared length', async () => {
    const location = await directory();
    const bytes = Buffer.from('build artifact');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(location, sha256), bytes);

    await expect(
      readSeedArtifact(location, { sha256, byteLength: bytes.length }, maximum),
    ).resolves.toStrictEqual(new Uint8Array(bytes));
  });

  it('rejects invalid digests and excessive or invalid declarations before selecting a file', () => {
    for (const sha256 of ['../outside', '/dev/zero', 'A'.repeat(64), '0'.repeat(63)]) {
      expect(() => {
        validateSeedArtifact({ sha256, byteLength: 0 }, maximum);
      }).toThrow(/invalid/u);
    }
    for (const byteLength of [-1, 1.5, Number.MAX_SAFE_INTEGER, maximum + 1]) {
      expect(() => {
        validateSeedArtifact({ sha256: '0'.repeat(64), byteLength }, maximum);
      }).toThrow(/invalid/u);
    }
  });

  it('rejects a directory, wrong length, and wrong hash', async () => {
    const location = await directory();
    const sha256 = '0'.repeat(64);
    const filename = path.join(location, sha256);
    await mkdir(filename);

    await expect(readSeedArtifact(location, { sha256, byteLength: 0 }, maximum)).rejects.toThrow(
      /regular/u,
    );

    await rm(filename, { recursive: true });
    await writeFile(filename, 'abc');

    await expect(readSeedArtifact(location, { sha256, byteLength: 2 }, maximum)).rejects.toThrow(
      /length/u,
    );
    await expect(readSeedArtifact(location, { sha256, byteLength: 4 }, maximum)).rejects.toThrow(
      /length/u,
    );
    await expect(readSeedArtifact(location, { sha256, byteLength: 3 }, maximum)).rejects.toThrow(
      /digest/u,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink and a FIFO without reading either',
    async () => {
      const location = await directory();
      const sha256 = '0'.repeat(64);
      const filename = path.join(location, sha256);
      const outside = path.join(location, 'outside');
      await writeFile(outside, 'abc');
      await symlink(outside, filename);

      await expect(readSeedArtifact(location, { sha256, byteLength: 3 }, maximum)).rejects.toThrow(
        /regular/u,
      );

      await rm(filename);
      execFileSync('/usr/bin/mkfifo', [filename]);

      await expect(readSeedArtifact(location, { sha256, byteLength: 0 }, maximum)).rejects.toThrow(
        /regular/u,
      );
    },
  );
});
