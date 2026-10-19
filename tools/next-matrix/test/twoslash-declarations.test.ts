import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FunctionSpec } from '@stayingupwind/core/bundle';
import { afterEach, describe, expect, it } from 'vitest';

import { checkedDeclarationSources } from '../src/twoslash-declarations.ts';

function module(name: string, source: string): FunctionSpec['modules'][number] {
  return {
    name,
    type: 'data',
    blob: {
      sha256: createHash('sha256').update(source).digest('hex'),
      byteLength: Buffer.byteLength(source),
      contentType: 'text/plain',
    },
  };
}

async function fixture() {
  const app = await mkdtemp(path.join(tmpdir(), 'upwind-declaration-proof-'));
  const trace = path.join(app, '.next', 'server', 'app', 'route.js.nft.json');
  const name = 'node_modules/typescript/lib/lib.d.ts';
  const source = 'interface String {}';
  await mkdir(path.dirname(trace), { recursive: true });
  await mkdir(path.dirname(path.join(app, name)), { recursive: true });
  await writeFile(path.join(app, name), source);
  const relative = path.relative(path.dirname(trace), path.join(app, name));
  await writeFile(trace, JSON.stringify({ files: [relative] }));
  return { app, trace, modules: [module(name, source)] };
}

describe('traced declaration proof', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('verifies emitted logical names and hashes against the actual traced source bytes', async () => {
    const input = await fixture();
    roots.push(input.app);

    await expect(checkedDeclarationSources(input.app, input)).resolves.toStrictEqual([
      {
        name: input.modules[0]!.name,
        sha256: input.modules[0]!.blob.sha256,
        byteLength: input.modules[0]!.blob.byteLength,
      },
    ]);
  });

  it('rejects a traced declaration omitted from the Function', async () => {
    const input = await fixture();
    roots.push(input.app);

    await expect(checkedDeclarationSources(input.app, { modules: [] })).rejects.toThrow(
      'exactly match the route trace',
    );
  });

  it('rejects an extra declaration that the route never traced', async () => {
    const input = await fixture();
    roots.push(input.app);
    input.modules.push(module('node_modules/typescript/lib/untraced.d.mts', 'interface Extra {}'));

    await expect(checkedDeclarationSources(input.app, input)).rejects.toThrow(
      'exactly match the route trace',
    );
  });

  it('rejects emitted declaration bytes different from their traced source', async () => {
    const input = await fixture();
    roots.push(input.app);
    input.modules[0] = module(input.modules[0]!.name, 'interface Wrong {}');

    await expect(checkedDeclarationSources(input.app, input)).rejects.toThrow('traced source hash');
  });

  it('fails when the actual route trace cannot be read', async () => {
    const input = await fixture();
    roots.push(input.app);
    await rm(input.trace);

    await expect(checkedDeclarationSources(input.app, input)).rejects.toThrow('ENOENT');
  });

  it('rejects a malformed trace instead of recording an unknown count', async () => {
    const input = await fixture();
    roots.push(input.app);
    await writeFile(input.trace, JSON.stringify({ files: [123] }));

    await expect(checkedDeclarationSources(input.app, input)).rejects.toThrow(
      'readable file inventory',
    );
  });
});
