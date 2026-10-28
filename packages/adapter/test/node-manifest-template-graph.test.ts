import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import { nodeManifestTemplateGraphFixture as fixture } from './fixtures/node-manifest-template-graph.ts';
function digest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

describe('finite route templates through the complete manifest consumer graph', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-template-graph-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['pages', 'app-route'] as const)(
    'closes the actual published %s template at the generated SDK entry',
    async (kind) => {
      const own = await fixture(directory, kind);
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.entries).toStrictEqual([
        { id: own.route.id, filePath: own.entry, canonicalFilePath: own.entry },
      ]);
      expect(proof.files.some((source) => source.file === own.entry)).toBe(true);
    },
  );

  it('rejects a constructor route definition that disagrees with the source-derived page', async () => {
    const own = await fixture(directory, 'pages');
    const code = own.code.replace("page: '/blog/[slug]'", "page: '/outside'");
    await writeFile(own.entry, code);
    own.graph.sources.set(own.entry, { file: own.entry, sha256: digest(code) });

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('template structure');
  });
});
