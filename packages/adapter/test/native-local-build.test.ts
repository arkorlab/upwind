import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { firstExistingNativeBinary } from '../src/native-local-build.ts';

describe('local native candidate paths from authored inert filesystem data', () => {
  let root: string;
  let release: string;
  let debug: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'authored-native-local-build-'));
    root = await realpath(temporary);
    release = path.join(root, 'build/Release/addon.node');
    debug = path.join(root, 'build/Debug/addon.node');
    await mkdir(path.dirname(release), { recursive: true });
    await mkdir(path.dirname(debug), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function linkedDirectory(folder: string): Promise<string> {
    const lookup = path.join(root, folder);
    const target = path.join(root, 'stored-directory');
    const relativeBinary = folder === 'build' ? 'Release/addon.node' : 'addon.node';
    const binary = path.join(target, relativeBinary);
    await rm(lookup, { recursive: true });
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, new Uint8Array([3]));
    await symlink(target, lookup);
    return binary;
  }

  it('keeps the first owned canonical regular candidate selected', async () => {
    await writeFile(release, new Uint8Array([1]));
    await writeFile(debug, new Uint8Array([2]));

    await expect(
      firstExistingNativeBinary([release, debug], new Set([debug, release])),
    ).resolves.toBe(release);
  });

  it('keeps the regular Debug candidate after an absent Release candidate', async () => {
    await writeFile(debug, new Uint8Array([2]));

    await expect(firstExistingNativeBinary([release, debug], new Set([debug]))).resolves.toBe(
      debug,
    );
  });

  it('keeps an absent candidate list unselected', async () => {
    await expect(firstExistingNativeBinary([release], new Set())).resolves.toBeUndefined();
  });

  it('does not skip an existing unowned candidate for an owned fallback', async () => {
    await writeFile(release, new Uint8Array([1]));
    await writeFile(debug, new Uint8Array([2]));

    await expect(firstExistingNativeBinary([release, debug], new Set([debug]))).rejects.toThrow(
      'first existing binary is not an owned regular file',
    );
  });

  it('keeps an owned directory candidate refused without falling back', async () => {
    await mkdir(release);
    await writeFile(debug, new Uint8Array([2]));

    await expect(
      firstExistingNativeBinary([release, debug], new Set([debug, release])),
    ).rejects.toThrow('first existing binary is not an owned regular file');
  });

  it('refuses a selected symlink filename even when its target and fallback are owned', async () => {
    const target = path.join(root, 'stored.node');
    await writeFile(target, new Uint8Array([3]));
    await writeFile(debug, new Uint8Array([2]));
    await symlink(target, release);

    await expect(
      firstExistingNativeBinary([release, debug], new Set([debug, target])),
    ).rejects.toThrow('lookup requires an unproved internal alias');
  });

  it.each(['build', 'build/Release', 'build/Debug'])(
    'refuses a selected binary beneath the symlinked %s lookup directory',
    async (folder) => {
      const binary = await linkedDirectory(folder);

      await expect(firstExistingNativeBinary([release, debug], new Set([binary]))).rejects.toThrow(
        'lookup requires an unproved internal alias',
      );
    },
  );

  it('keeps nonmissing resolution errors instead of selecting a fallback', async () => {
    await symlink('addon.node', release);
    await writeFile(debug, new Uint8Array([2]));

    await expect(
      firstExistingNativeBinary([release, debug], new Set([debug])),
    ).rejects.toMatchObject({ code: 'ELOOP' });
  });
});
