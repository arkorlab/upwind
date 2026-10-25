import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import { appEntrySource } from '../src/app-entry.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import { nodeManifestNormalization } from '../src/node-manifest-normalization.ts';
import { nodeManifestPagesDefinitions } from '../src/node-manifest-pages-definitions.ts';
import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import { assertNodeProofFiles } from '../src/node-proof.ts';
import { nodeManifestTemplateGraphFixture } from './fixtures/node-manifest-template-graph.ts';
import { manifestTemplateProofFixture } from './fixtures/node-manifest-turbopack-proof.ts';
import {
  projectedTemplateFixture,
  reprojectTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}
type Fixture = Awaited<ReturnType<typeof nodeManifestTemplateGraphFixture>>;
async function rootEntry(own: Fixture): Promise<void> {
  const code = appEntrySource(own.input.entries, {
    external: true,
    runtimeDistDir: own.input.distDir,
    nodeRequestMeta: true,
  });
  await writeFile(own.input.analysisEntry, code);
  own.graph.sources.set(own.input.analysisEntry, {
    file: own.input.analysisEntry,
    sha256: digest(code),
  });
}
async function canonicalFixture(
  directory: string,
  pathname: string,
  sourcePage: string,
  aliases: readonly string[],
): Promise<Fixture> {
  const own = await nodeManifestTemplateGraphFixture(directory, 'pages');
  const code = own.code
    .replaceAll('/blog/[slug]', () => sourcePage)
    .replace(`pathname: '${sourcePage}'`, () => `pathname: '${pathname}'`);
  await writeFile(own.entry, code);
  own.graph.sources.set(own.entry, { file: own.entry, sha256: digest(code) });
  own.input.entries = aliases.map((id) => ({ id, filePath: own.entry }));
  own.input.runtimeManifest = JSON.stringify({
    entrypoints: aliases.map((id) => ({ id, pathname: id, kind: 'pages' })),
  });
  await rootEntry(own);
  await writeFile(
    path.join(own.input.distDir, 'server/pages-manifest.json'),
    JSON.stringify({ [pathname]: 'pages/blog/[slug].js' }),
  );
  return own;
}

describe('canonical Pages definitions and logical SDK aliases', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-pages-definition-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    [
      'data alias',
      '/blog/[slug]',
      '/blog/[slug]',
      ['/blog/[slug]', '/_next/data/build/blog/[slug].json'],
    ],
    ['shared error', '/_error', '/_error', ['/404', '/500', '/_error']],
    ['root index', '/', '/index', ['/', '/_next/data/build/index.json']],
    ['nested index', '/about', '/about/index', ['/about', '/_next/data/build/about.json']],
    ['literal index', '/index', '/index/index', ['/index', '/_next/data/build/index/index.json']],
    ['basePath', '/about', '/about/index', ['/docs/about', '/docs/_next/data/build/about.json']],
  ] as const)(
    'closes a complete published Pages graph with %s',
    async (_name, pathname, sourcePage, aliases) => {
      const own = await canonicalFixture(directory, pathname, sourcePage, aliases);
      const proof = await proveNodeManifests(own.input, own.graph);
      const manifest = path.join(own.input.distDir, 'server/pages-manifest.json');

      expect(proof.normalization?.entries.map((entry) => entry.id)).toStrictEqual(aliases);
      expect(proof.files).toContainEqual({
        file: manifest,
        sha256: digest(await readFile(manifest)),
      });
      expect(proof.codeSources.map((source) => source.file)).not.toContain(manifest);
      expect(proof.approvedCompilerSources.map((source) => source.file)).not.toContain(manifest);
    },
  );

  it.each(['/blog/[slug]', '/blog/[slug]/index'])(
    'closes selected Turbopack Pages %s factories with data aliases at the exact SDK root',
    async (page) => {
      const own = await manifestTemplateProofFixture(directory, 'pages');
      const chunk = (await readFile(own.chunk, 'utf8'))
        .replaceAll('/blog/[slug]', () => page)
        .replace(`pathname: '${page}'`, "pathname: '/blog/[slug]'");
      await writeFile(own.chunk, chunk);
      own.sources.set(own.chunk, { file: own.chunk, sha256: digest(chunk) });
      const ids = ['/docs/blog/[slug]', '/docs/_next/data/build/blog/[slug].json'];
      own.input.entries = ids.map((id) => ({ id, filePath: own.entry }));
      own.input.runtimeManifest = JSON.stringify({
        entrypoints: ids.map((id) => ({ id, pathname: id, kind: 'pages' })),
      });
      const entryCode = appEntrySource(own.input.entries, {
        external: true,
        runtimeDistDir: own.input.distDir,
        nodeRequestMeta: true,
      });
      await writeFile(own.analysisEntry, entryCode);
      own.sources.set(own.analysisEntry, { file: own.analysisEntry, sha256: digest(entryCode) });
      await writeFile(
        path.join(own.input.distDir, 'server/pages-manifest.json'),
        JSON.stringify({ '/blog/[slug]': 'pages/blog/[slug].js' }),
      );
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.entries.map((entry) => entry.id)).toStrictEqual(ids);
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
      expect(proof.codeSources.map((source) => source.file)).toContain(own.chunk);
    },
  );

  it('requires compiler metadata for a shared physical constructor', async () => {
    const own = await canonicalFixture(directory, '/_error', '/_error', ['/404', '/_error']);
    await rm(path.join(own.input.distDir, 'server/pages-manifest.json'));

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'conflicting definitions',
    );
  });

  it.each([
    ['duplicate JSON keys', '{"/_error":"pages/blog/[slug].js","/_error":"pages/blog/[slug].js"}'],
    [
      'ambiguous physical page',
      '{"/_error":"pages/blog/[slug].js","/other":"pages/blog/[slug].js"}',
    ],
    ['missing owned page', '{}'],
    ['escaping target', '{"/_error":"../outside.js"}'],
    ['escaping pathname', '{"/../_error":"pages/blog/[slug].js"}'],
    ['invalid value', '{"/_error":false}'],
  ])('refuses %s in canonical compiler data', async (_name, contents) => {
    const own = await canonicalFixture(directory, '/_error', '/_error', ['/404', '/_error']);
    await writeFile(path.join(own.input.distDir, 'server/pages-manifest.json'), contents);

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('canonical Pages');
  });

  it('keeps every alias kind and metadata identity checked', async () => {
    const own = await canonicalFixture(directory, '/_error', '/_error', ['/404', '/_error']);
    own.input.runtimeManifest = JSON.stringify({
      entrypoints: [
        { id: '/404', kind: 'pages', pathname: '/404' },
        { id: '/_error', kind: 'pages-api', pathname: '/_error' },
      ],
    });

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'conflicting definitions',
    );
  });

  it.each(['/other', '/about/index/index'])(
    'refuses unsupported original definition.page %s',
    async (sourcePage) => {
      const own = await canonicalFixture(directory, '/about', sourcePage, ['/docs/about']);

      await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('definition scalar');
    },
  );

  it('does not permit a symlinked manifest source', async () => {
    const own = await canonicalFixture(directory, '/_error', '/_error', ['/404', '/_error']);
    const manifest = path.join(own.input.distDir, 'server/pages-manifest.json');
    const alias = path.join(directory, 'alias.json');
    await writeFile(alias, await readFile(manifest));
    await rm(manifest);
    await symlink(alias, manifest);

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('physical source');
  });

  it('refuses a symlinked canonical manifest target even inside the build', async () => {
    const own = await canonicalFixture(directory, '/_error', '/_error', ['/404', '/_error']);
    await symlink(own.entry, path.join(own.input.distDir, 'server/pages/linked.js'));
    await writeFile(
      path.join(own.input.distDir, 'server/pages-manifest.json'),
      JSON.stringify({ '/_error': 'pages/linked.js' }),
    );

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('manifest target');
  });

  it('does not add unrelated compiler manifest rows to the SDK executable inventory', async () => {
    const own = await canonicalFixture(directory, '/_error', '/_error', ['/404', '/_error']);
    const other = path.join(own.input.distDir, 'server/pages/other.js');
    await writeFile(other, 'throw new Error("must never become an entry");');
    await writeFile(
      path.join(own.input.distDir, 'server/pages-manifest.json'),
      JSON.stringify({ '/_error': 'pages/blog/[slug].js', '/other': 'pages/other.js' }),
    );
    const proof = await proveNodeManifests(own.input, own.graph);

    expect(proof.normalization?.entries.map((entry) => entry.id)).toStrictEqual([
      '/404',
      '/_error',
    ]);
    expect(proof.codeSources.map((source) => source.file)).not.toContain(other);
  });

  it('rechecks certified metadata bytes in the physical artifact before publication', async () => {
    const own = await canonicalFixture(directory, '/_error', '/_error', ['/404', '/_error']);
    const proof = await proveNodeManifests(own.input, own.graph);
    const manifest = path.join(own.input.distDir, 'server/pages-manifest.json');
    const input = {
      repoRoot: directory,
      projectDir: directory,
      patch: { distDir: own.input.distDir },
      entries: own.input.entries,
      entryTraces: [],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;
    const physical = await nodePhysicalFiles(input, [], proof.normalization?.metadataFiles);
    const metadata = proof.files.filter((source) => source.file === manifest);

    expect(() => {
      assertNodeProofFiles({ files: metadata, native: [] }, physical, new Map());
    }).not.toThrow(Error);

    await writeFile(manifest, '{}');
    const changed = await nodePhysicalFiles(input, [], proof.normalization?.metadataFiles);

    expect(() => {
      assertNodeProofFiles({ files: metadata, native: [] }, changed, new Map());
    }).toThrow('absent or changed');
  });

  it('checks the same manifest-bound index scalar after fresh selected Turbopack projection', async () => {
    const own = await canonicalFixture(directory, '/about', '/about/index', ['/docs/about']);
    const normalization = await nodeManifestNormalization(own.input);
    const canonical = await nodeManifestPagesDefinitions(normalization, new Set([own.entry]));
    const definition = canonical.definitions.get(own.entry);
    assert(definition !== undefined);
    const original = await projectedTemplateFixture('pages');
    const code = original.projection.original.code
      .replaceAll('/blog/[slug]', '/about/index')
      .replace("pathname: '/about/index'", "pathname: '/about'");
    const modified = reprojectTemplateFixture(original, code);
    const proof = await assertNodeManifestTurbopackTemplateConsumer({
      ...modified,
      route: { kind: 'pages', page: definition.page, pathname: definition.pathname, definition },
    });

    expect(proof.page).toBe('/about/index');
    await expect(
      assertNodeManifestTurbopackTemplateConsumer({
        ...modified,
        route: { kind: 'pages', page: definition.page, pathname: '/elsewhere', definition },
      }),
    ).rejects.toThrow('definition scalar');
    await expect(
      assertNodeManifestTurbopackTemplateConsumer({
        ...modified,
        route: {
          kind: 'pages',
          page: definition.page,
          pathname: definition.pathname,
          definition: { ...definition },
        },
      }),
    ).rejects.toThrow('definition scalar');
  });
});
