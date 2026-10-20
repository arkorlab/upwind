import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { nftAssets } from '../src/nft.ts';
import { tracedFiles } from '../src/traced-files.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'upwind-hook-nft-'));
  const projectDir = path.join(root, 'apps', 'site');
  const distDir = path.join(projectDir, '.next');
  const entry = path.join(distDir, 'server', 'instrumentation.js');
  const lib = path.join(root, 'node_modules', 'typescript', 'lib');
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(lib, { recursive: true });
  await writeFile(entry, 'exports.register = () => {};');
  await writeFile(path.join(lib, '..', 'package.json'), '{"name":"typescript"}');
  const declaration = path.join(lib, 'lib.d.ts');
  const data = path.join(projectDir, 'data.json');
  await writeFile(declaration, 'interface String {}');
  await writeFile(data, '{}');
  return { root, projectDir, distDir, entry, declaration, data };
}

async function trace(entry: string, files: readonly string[]): Promise<void> {
  await writeFile(
    `${entry}.nft.json`,
    JSON.stringify({
      files: files.map((file) => path.relative(path.dirname(entry), file)),
    }),
  );
}

describe('instrumentation nft asset identities', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('gives hook declarations trusted repository keys and keeps ordinary data project-relative', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    await trace(setup.entry, [setup.declaration, setup.data]);
    const assets = await nftAssets(setup.entry, setup.root);

    expect(assets).toStrictEqual({
      'node_modules/typescript/lib/lib.d.ts': setup.declaration,
      'apps/site/data.json': setup.data,
    });
    expect(tracedFiles([{ assets }], setup.projectDir, setup.distDir, setup.root)).toStrictEqual([
      { name: 'data.json', filePath: setup.data },
      { name: 'node_modules/typescript/lib/lib.d.ts', filePath: setup.declaration },
    ]);
  });

  it('keeps an out-of-repository hook declaration rejected', async () => {
    const setup = await fixture();
    roots.push(setup.root);
    const outside = await mkdtemp(path.join(tmpdir(), 'upwind-hook-outside-'));
    roots.push(outside);
    const declaration = path.join(outside, 'outside.d.ts');
    await writeFile(declaration, 'interface Outside {}');
    await trace(setup.entry, [declaration]);
    const assets = await nftAssets(setup.entry, setup.root);

    expect(Object.values(assets)).toStrictEqual([declaration]);
    expect(() => tracedFiles([{ assets }], setup.projectDir, setup.distDir, setup.root)).toThrow(
      AuditError,
    );
  });
});
