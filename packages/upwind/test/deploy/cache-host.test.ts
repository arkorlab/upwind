import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CACHE_HOST_FILE, cacheHostModuleFor } from '../../src/deploy/cache-host.ts';
import { type CacheHostSource, sha256Of } from '../../src/deploy/shipped.ts';

/** The adapter a project would have: this repository's own, which depends on the runtime and the core. */
const ADAPTER = fileURLToPath(new URL('../../../adapter/src/index.ts', import.meta.url));

/** Where the adapter resolves a specifier: where the rewritten host has to import it from. */
function resolvedFrom(specifier: string): string {
  return createRequire(ADAPTER).resolve(specifier).split(path.sep).join('/');
}

/** A shipped host of that text, with the digest its manifest would name. */
function shipped(text: string): Extract<CacheHostSource, { kind: 'bundle' }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-cache-host-'));
  const file = path.join(dir, 'cache-host.mjs');
  writeFileSync(file, text);
  return { kind: 'bundle', path: file, sha256: sha256Of(text) };
}

describe("the cache host a deploy's build names", () => {
  it('is the cache package’s own module, from the sources', async () => {
    await expect(
      cacheHostModuleFor({ kind: 'source', path: '/sources/host.ts' }, '/project', ADAPTER),
    ).resolves.toBe('/sources/host.ts');
  });

  it("is the shipped one, pointed at the runtime the project's adapter resolves", async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'upwind-cache-host-project-'));
    const source = shipped(
      [
        'import { a } from "@stayingupwind/core/util";',
        "import { CacheHostError } from '@stayingupwind/runtime/cache-host';",
        'import { b } from "./kept.js";',
      ].join('\n'),
    );
    const module = await cacheHostModuleFor(source, project, ADAPTER);

    expect(module).toBe(path.join(project, CACHE_HOST_FILE));

    const text = readFileSync(module, 'utf8');

    expect(text).toContain(`from "${resolvedFrom('@stayingupwind/core/util')}"`);
    expect(text).toContain(`from '${resolvedFrom('@stayingupwind/runtime/cache-host')}'`);
    expect(text).toContain('from "./kept.js"');
    expect(text).not.toContain('@stayingupwind/');
  });

  it('refuses an adapter that resolves none of what the host needs', async () => {
    const source = shipped('import { a } from "@stayingupwind/core/none";');
    const project = mkdtempSync(path.join(tmpdir(), 'upwind-cache-host-project-'));

    await expect(cacheHostModuleFor(source, project, ADAPTER)).rejects.toThrow(
      'resolves none of @stayingupwind/core/none',
    );
  });

  it('refuses a shipped host that is not the one its manifest names', async () => {
    const source = shipped('export {};');
    const project = mkdtempSync(path.join(tmpdir(), 'upwind-cache-host-project-'));

    await expect(
      cacheHostModuleFor({ ...source, sha256: sha256Of('other') }, project, ADAPTER),
    ).rejects.toThrow('not the one its manifest names');
  });
});
