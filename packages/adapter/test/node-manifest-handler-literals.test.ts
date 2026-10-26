import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import { certifyNodeManifestCompilerRoot } from '../src/node-manifest-compiler-root.ts';
import type { NodeManifestHandlerProfile } from '../src/node-manifest-handler-catalog.ts';
import { nodeManifestHandlerLiteralValues } from '../src/node-manifest-handler-literals.ts';

describe('sealed compiler-relative handler literal DATA', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'handler-literal-data-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(root = directory) {
    const project = path.join(directory, 'app');
    const distDir = path.join(project, '.next');
    const nextRoot = path.join(project, 'node_modules/next');
    await mkdir(distDir, { recursive: true });
    await mkdir(nextRoot, { recursive: true });
    await writeFile(
      path.join(distDir, 'required-server-files.json'),
      JSON.stringify({
        version: 1,
        appDir: project,
        relativeAppDir: '',
        config: {
          distDir: '.next',
          turbopack: { root },
          experimental: { isExperimentalCompile: false },
        },
        files: ['.next/required-server-files.json', '.next/BUILD_ID'],
        ignore: [],
      }),
    );
    const input = { projectDir: project, distDir };
    const proof = await certifyNodeManifestCompilerRoot(input);
    assert(proof !== undefined);
    const relative = 'dist/compiled/authored/runtime.js';
    const profile: Pick<NodeManifestHandlerProfile, 'literalSlots' | 'sources'> = {
      sources: [{ relative, sha256: 'authored DATA pin only' }],
      literalSlots: [
        {
          key: 'dir',
          row: { runtime: 'reference', moduleId: 1 },
          path: ['callback', 'body', 'body', 0, 'value'],
          referenceValue: '/ROOT/reference/',
          origin: { kind: 'compiler-relative-next-source-directory-with-trailing-slash', relative },
        },
      ],
    };
    return { binding: { proof, input }, distDir, nextRoot, profile, project };
  }

  it('derives only the complete primary producer grammar from the sealed root and exact origin', async () => {
    const own = await fixture();
    const value = nodeManifestHandlerLiteralValues(own);

    expect(value?.actual).toStrictEqual([
      { key: 'dir', value: '/ROOT/app/node_modules/next/dist/compiled/authored/' },
    ]);
    expect(value?.expected).toBe(own.profile.literalSlots);
    expect(value).not.toHaveProperty('member');
    expect(value).not.toHaveProperty('approval');
  });

  it('uses the persisted compiler root rather than a guessed project root', async () => {
    const own = await fixture(path.join(directory, 'app'));

    expect(nodeManifestHandlerLiteralValues(own)?.actual).toStrictEqual([
      { key: 'dir', value: '/ROOT/node_modules/next/dist/compiled/authored/' },
    ]);
  });

  it('declines missing binding, a mismatched output and a source outside the sealed root', async () => {
    const own = await fixture();

    expect(nodeManifestHandlerLiteralValues({ ...own, binding: undefined })).toBeUndefined();
    expect(
      nodeManifestHandlerLiteralValues({ ...own, distDir: path.join(directory, 'other-output') }),
    ).toBeUndefined();
    expect(nodeManifestHandlerLiteralValues({ ...own, nextRoot: '/foreign/next' })).toBeUndefined();
  });

  it('does not derive an origin without its independently listed raw source pin', async () => {
    const own = await fixture();

    expect(
      nodeManifestHandlerLiteralValues({ ...own, profile: { ...own.profile, sources: [] } }),
    ).toBeUndefined();
  });

  it('declines unsupported origin grammar and an empty directory-relative basis', async () => {
    const own = await fixture();
    const slot = own.profile.literalSlots[0];
    assert(slot !== undefined);
    const empty = { ...slot, origin: { ...slot.origin, relative: 'runtime.js' } };

    expect(
      nodeManifestHandlerLiteralValues({
        ...own,
        nextRoot: directory,
        profile: {
          sources: [{ relative: 'runtime.js', sha256: 'authored' }],
          literalSlots: [empty],
        },
      }),
    ).toBeUndefined();

    Reflect.set(slot.origin, 'kind', 'unqualified-prefix-replacement');

    expect(nodeManifestHandlerLiteralValues(own)).toBeUndefined();
  });

  it('rejects a copied proof input even when its JSON paths match', async () => {
    const own = await fixture();

    expect(() => {
      return nodeManifestHandlerLiteralValues({
        ...own,
        binding: { ...own.binding, input: { ...own.binding.input } },
      });
    }).toThrow('foreign or copied proof');
  });

  it('declines a declared compiler-root symlink instead of guessing the emitter basis', async () => {
    const alias = path.join(directory, 'root-alias');
    await symlink(directory, alias);
    const own = await fixture(alias);

    expect(nodeManifestHandlerLiteralValues(own)).toBeUndefined();
  });
});
