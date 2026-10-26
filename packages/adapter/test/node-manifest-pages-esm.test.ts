import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeManifestPagesEsmTemplate } from '../src/node-manifest-pages-esm.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import { mutatePagesEsmFixture, pagesEsmFixture } from './fixtures/node-manifest-pages-esm.ts';
import { projectedTemplateFixture } from './fixtures/node-manifest-turbopack-template.ts';

describe('fixed Pages ESM template inspection', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'pages-esm-primary-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { kind: 'const', grouped: false },
    { kind: 'let', grouped: true },
    { kind: 'var', grouped: true },
  ] as const)(
    'matches the complete independently authored $kind/grouped=$grouped factory',
    async (options) => {
      const input = await pagesEsmFixture(options);
      const original = input.projection.original.code;
      const proof = await assertNodeManifestTurbopackTemplateConsumer(input);

      expect(proof).toMatchObject({ kind: 'pages', requiresRuntimeNormalization: true });
      expect(proof.exports).toContain('routeModule');
      expect(proof.exports).toContain('handler');
      expect(input.projection.original.code).toBe(original);
      expect(proof).not.toHaveProperty('approvedCompilerSources');
    },
  );

  it('retains eager export captures at the original callsite', async () => {
    const input = await pagesEsmFixture({ eager: true });

    await expect(assertNodeManifestTurbopackTemplateConsumer(input)).resolves.toMatchObject({
      kind: 'pages',
    });
  });

  it('keeps the exact CJS wildcard template profile intact', async () => {
    const input = await projectedTemplateFixture('pages');

    await expect(assertNodeManifestTurbopackTemplateConsumer(input)).resolves.toMatchObject({
      kind: 'pages',
    });
  });

  it.each(['program', 'function'])(
    'accepts a genuine inherited %s directive without inventing factory strictness',
    async (scope) => {
      const input = await pagesEsmFixture();
      const original = input.projection.original.code;
      const body = original.replace('"use strict";', () => '');
      const inherited =
        scope === 'program' ? `"use strict";${body}` : `(function(){"use strict";${body}})();`;
      const changed = mutatePagesEsmFixture(input, original, inherited);

      await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).resolves.toMatchObject({
        kind: 'pages',
      });
    },
  );

  it.each(['`use strict`;', String.raw`"use\x20strict";`, '("use strict");'])(
    'refuses a false original strict directive %s',
    async (directive) => {
      const input = mutatePagesEsmFixture(await pagesEsmFixture(), '"use strict";', directive);

      await expect(assertNodeManifestTurbopackTemplateConsumer(input)).rejects.toThrow(
        'unproved factory strictness',
      );
    },
  );

  it('does not use a non-prologue string as original strictness', async () => {
    const input = mutatePagesEsmFixture(
      await pagesEsmFixture(),
      '"use strict";',
      '0;"use strict";',
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(input)).rejects.toThrow(
      'unproved factory strictness',
    );
  });

  it('refuses raw require namespace ports even with the same selected sources and fields', async () => {
    const input = await pagesEsmFixture({ namespaceMethod: 'r' });

    await expect(assertNodeManifestTurbopackTemplateConsumer(input)).rejects.toThrow(
      'namespace import mode',
    );
  });

  it('cannot claim an esmImport mode through changed projection metadata', async () => {
    const input = await pagesEsmFixture({ namespaceMethod: 'r' });
    const projection = {
      ...input.projection,
      imports: input.projection.imports.map((entry) => {
        if (entry.kind !== 'require') return entry;
        return { ...entry, kind: 'import' as const };
      }),
    };

    await expect(
      assertNodeManifestTurbopackTemplateConsumer({ ...input, projection }),
    ).rejects.toThrow('projection provenance');
  });

  it('refuses an eager export observation before the original var initializer', async () => {
    const input = await pagesEsmFixture({ eager: true });
    const code = input.projection.original.code;
    const start = code.indexOf('context.s([');
    const end = code.indexOf(']);', start) + ']);'.length;
    const table = code.slice(start, end);
    const changed = code.slice(0, start) + code.slice(end);
    const moved = changed.replace('"use strict";', () => `"use strict";${table}`);
    const early = mutatePagesEsmFixture(input, code, moved);

    await expect(assertNodeManifestTurbopackTemplateConsumer(early)).rejects.toThrow(
      'read before initializer completion',
    );
  });

  it('keeps extra actual wildcard helper bodies and effects in the full comparison', async () => {
    const input = await pagesEsmFixture();
    const changed = mutatePagesEsmFixture(
      input,
      '"use strict";',
      '"use strict";function _interop_require_wildcard(value){return value;}',
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'changed ESM handler or constructor body',
    );
  });

  it.each([
    ['(0,handlerNs.getHandler)(', 'handlerNs.getHandler('],
    ["page: '/blog/[slug]'", "page: '/different'"],
    ['kindNs.RouteKind.PAGES', 'kindNs.RouteKind.PAGES_API'],
    ['new moduleNs.PagesRouteModule(', 'new moduleNs.UnknownModule('],
    ['context.s([', 'extraEffect();context.s(['],
    ['"use strict";', ''],
  ])('refuses changed original template behavior %s', async (before, after) => {
    const input = mutatePagesEsmFixture(await pagesEsmFixture(), before, after);

    await expect(assertNodeManifestTurbopackTemplateConsumer(input)).rejects.toThrow(
      'refusing native publication',
    );
  });

  async function copiedPrimary() {
    const anchor = await realpath(
      fileURLToPath(import.meta.resolve('next/dist/build/templates/pages.js')),
    );
    const root = path.resolve(path.dirname(anchor), '../../..');
    for (const relative of [
      'dist/build/templates/pages.js',
      'dist/build/load-entrypoint.js',
      'dist/esm/build/templates/pages.js',
    ]) {
      const target = path.join(directory, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(root, relative)));
    }
    return directory;
  }

  it.each([
    'dist/build/templates/pages.js',
    'dist/build/load-entrypoint.js',
    'dist/esm/build/templates/pages.js',
  ])('requires exact public producer bytes at %s', async (relative) => {
    const root = await copiedPrimary();
    await writeFile(path.join(root, relative), 'unreviewed source;');

    await expect(nodeManifestPagesEsmTemplate(root)).rejects.toThrow('pinned source bytes');
  });
});
