import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Entrypoint } from '@stayingupwind/core/bundle';
import { AdapterOutputType } from 'next/dist/shared/lib/constants.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import { collectPrerenders, type PrerenderCollection } from '../src/collect.ts';

type Output = PrerenderCollection['outputs']['prerenders'][number];
const BASE_PATH = '/docs';
const ROUTE = '/docs/items/[id]';
const ENTRY: Entrypoint = { id: ROUTE, kind: 'app-page', pathname: ROUTE };
const PAGE: PrerenderCollection['outputs']['appPages'][number] = {
  id: 'page',
  type: AdapterOutputType.APP_PAGE,
  pathname: ROUTE,
  sourcePage: '/items/[id]/page',
  runtime: 'nodejs',
  filePath: '/unused/page.js',
  assets: {},
  assetsHashes: {},
  config: {},
};
const RANGE = { minBytes: 8, maxBytes: 16 };
const RSC: PrerenderCollection['rsc'] = {
  header: 'rsc',
  varyHeader: 'rsc',
  prefetchHeader: 'next-router-prefetch',
  didPostponeHeader: 'x-nextjs-postponed',
  contentTypeHeader: 'text/x-component',
  suffix: '.rsc',
  prefetchSegmentHeader: 'next-router-segment-prefetch',
  prefetchSegmentSuffix: '.segment.rsc',
  prefetchSegmentDirSuffix: '.segments',
  clientParamParsing: false,
  clientParamParsingOrigins: undefined,
  dynamicRSCPrerender: false,
};

const ORDERS = [
  { label: 'document first', order: (outputs: Output[]) => outputs },
  { label: 'Flight first', order: (outputs: Output[]) => outputs.toReversed() },
];

function requiredDocument(outputs: Output[]): Output {
  const found = outputs.find((each) => each.id === 'document');
  if (found === undefined) throw new Error('missing document');
  return found;
}

function document(output: Output): Output {
  return { ...output, routeType: 'page', response: 'complete', compute: 'static' };
}

describe('completed page bodies collected without Function copies', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upwind-page-bodies-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function output(id: string, pathname: string, bytes: string): Promise<Output> {
    const filePath = path.join(directory, `${id}${pathname.endsWith('.rsc') ? '.rsc' : '.html'}`);
    await writeFile(filePath, bytes);
    return {
      id,
      type: AdapterOutputType.PRERENDER,
      pathname,
      route: '/items/[id]',
      parentOutputId: 'page',
      groupId: 1,
      config: {},
      fallback: { filePath, postponedState: undefined },
    };
  }

  async function pair(): Promise<Output[]> {
    return [
      document(await output('document', '/docs/items/one', 'HTML1234')),
      await output('flight', '/docs/items/one.rsc', 'opaqueFlight1234'),
    ];
  }

  async function collect(
    prerenders: Output[],
    options: Partial<Omit<PrerenderCollection, 'outputs' | 'blobs' | 'basePath' | 'rsc'>> = {},
  ) {
    const outDir = await mkdtemp(path.join(directory, 'bundle-'));
    const blobs = new BlobStore(outDir);
    await blobs.init();
    const result = await collectPrerenders({
      outputs: {
        prerenders,
        pages: [],
        appPages: [PAGE],
        appRoutes: [],
        pagesApi: [],
        staticFiles: [],
      },
      blobs,
      basePath: BASE_PATH,
      rsc: RSC,
      entrypoints: [ENTRY],
      ...options,
    });
    const uploaded = await Promise.all(
      (await readdir(path.join(outDir, 'blobs')))
        .toSorted((a, b) => a.localeCompare(b))
        .map(async (sha256) => ({
          sha256,
          bytes: await readFile(path.join(outDir, 'blobs', sha256)),
        })),
    );
    return { ...result, uploaded };
  }

  it('keeps default output and all upload bytes identical when the range is absent', async () => {
    const inputs = await pair();
    const ordinary = await collect(inputs);
    const explicit = await collect(inputs, { unshippedBodies: undefined });

    expect(explicit).toStrictEqual(ordinary);
    expect(ordinary.shipped.map(({ routes }) => routes)).toStrictEqual([[ROUTE], [ROUTE]]);
    expect(ordinary.uploaded).toHaveLength(2);
  });

  it.each(ORDERS)(
    'omits inclusive boundary bodies in either sibling order: $label',
    async ({ order }) => {
      const inputs = order(await pair());
      const ordinary = await collect(inputs);
      const selected = await collect(inputs, { unshippedBodies: RANGE });

      expect(selected.prerenders).toStrictEqual(ordinary.prerenders);
      expect(selected.uploaded).toStrictEqual(ordinary.uploaded);
      expect(selected.shipped).toStrictEqual([]);
      expect(
        selected.uploaded.map(({ bytes }) => bytes.byteLength).toSorted((a, b) => a - b),
      ).toStrictEqual([RANGE.minBytes, RANGE.maxBytes]);
    },
  );

  it('keeps sizes immediately outside either inclusive boundary', async () => {
    const inputs = [
      document(await output('small', '/docs/items/small', '1234567')),
      { ...document(await output('large', '/docs/items/large', '12345678901234567')), groupId: 2 },
    ];
    const ordinary = await collect(inputs);
    const selected = await collect(inputs, { unshippedBodies: RANGE });

    expect(selected).toStrictEqual(ordinary);
    expect(selected.shipped).toHaveLength(2);
  });

  it.each(ORDERS)(
    'keeps raw postponed document state and its Flight sibling regardless of order: $label',
    async ({ order }) => {
      const inputs = await pair();
      const first = requiredDocument(inputs);
      inputs[0] = {
        ...first,
        fallback: { filePath: first.fallback?.filePath, postponedState: 'opaque postponed state' },
      };
      const orderedInputs = order(inputs);
      const ordinary = await collect(orderedInputs);
      const selected = await collect(orderedInputs, { unshippedBodies: RANGE });

      expect(selected).toStrictEqual(ordinary);
      expect(selected.shipped).toHaveLength(3);
      expect(selected.prerenders.find(({ id }) => id === 'document')?.postponed).toBeDefined();
    },
  );

  it.each([
    { label: 'shared class', change: { pathname: ROUTE } },
    { label: 'fallback', change: { routeType: 'fallback' as const } },
    { label: 'initial response', change: { response: 'initial' as const } },
    { label: 'resuming', change: { compute: 'resuming' as const } },
    { label: 'non-success status', change: { fallback: { initialStatus: 404 } } },
    { label: 'partial fallback', change: { config: { partialFallback: true } } },
  ])('keeps $label bodies in the Function', async ({ change }) => {
    const inputs = await pair();
    const first = requiredDocument(inputs);
    inputs[0] = {
      ...first,
      ...change,
      fallback: {
        filePath: first.fallback?.filePath,
        postponedState: undefined,
        ...change.fallback,
      },
    };
    const ordinary = await collect(inputs);

    await expect(collect(inputs, { unshippedBodies: RANGE })).resolves.toStrictEqual(ordinary);
  });

  it.each([
    { kind: 'pages' as const },
    { kind: 'app-route' as const },
    { runtime: 'edge' as const },
  ])('keeps bodies without a matching Node App page entry: %j', async (change) => {
    const inputs = await pair();
    const options = { entrypoints: [{ ...ENTRY, ...change }] };
    const ordinary = await collect(inputs, options);

    await expect(collect(inputs, { ...options, unshippedBodies: RANGE })).resolves.toStrictEqual(
      ordinary,
    );
  });

  it('keeps a document whose raw parent is not a Node App output', async () => {
    const inputs = (await pair()).map((each) => ({ ...each, parentOutputId: 'missing-parent' }));
    const ordinary = await collect(inputs);

    await expect(collect(inputs, { unshippedBodies: RANGE })).resolves.toStrictEqual(ordinary);
    expect(ordinary.shipped).toHaveLength(2);
  });

  it('keeps unclassified, internal-error, wrong-parent and wrong-group outputs local', async () => {
    const inputs = [
      await output('unclassified', '/docs/items/unclassified', '12345678'),
      {
        ...document(await output('error', '/docs/_not-found', 'error123')),
        route: '/_not-found',
        parentOutputId: 'error',
        groupId: 2,
      },
      document(await output('document', '/docs/items/one', 'HTML1234')),
      {
        ...(await output('wrong-parent', '/docs/items/one.rsc', 'parent12')),
        parentOutputId: 'another',
      },
      { ...(await output('wrong-group', '/docs/items/one.rsc', '87654321')), groupId: 3 },
    ];
    const entries = [
      ENTRY,
      { id: 'error', kind: 'app-page' as const, pathname: '/docs/_not-found' },
    ];
    const selected = await collect(inputs, { unshippedBodies: RANGE, entrypoints: entries });

    expect(
      selected.shipped.map(({ sha256 }) => sha256).toSorted((a, b) => a.localeCompare(b)),
    ).toStrictEqual(
      selected.prerenders
        .filter(({ id }) => id !== 'document')
        .map(({ body }) => body?.sha256 ?? '')
        .toSorted((a, b) => a.localeCompare(b)),
    );
    expect(selected.uploaded).toHaveLength(inputs.length);
  });

  it('combines whole-body omission with existing segment omission independently', async () => {
    const inputs = [
      ...(await pair()),
      await output('segment', '/docs/items/one.segments/_tree.segment.rsc', 'segment1'),
    ];
    const ordinary = await collect(inputs);
    const bodies = await collect(inputs, { unshippedBodies: RANGE });
    const both = await collect(inputs, { unshippedBodies: RANGE, unshipped: 'prefetch-segments' });

    expect(bodies.shipped.map(({ sha256 }) => sha256)).toStrictEqual([
      bodies.prerenders.find(({ id }) => id === 'segment')?.body?.sha256,
    ]);
    expect(both.shipped).toStrictEqual([]);
    expect({ prerenders: both.prerenders, uploaded: both.uploaded }).toStrictEqual({
      prerenders: ordinary.prerenders,
      uploaded: ordinary.uploaded,
    });
    expect(both.prerenders.find(({ id }) => id === 'segment')?.segmentPath).toBe('/_tree');
  });

  it('retains a shared SHA only for routes still requiring Function bytes', async () => {
    const inputs = [
      document(await output('complete', '/docs/items/one', 'shared12')),
      {
        ...document(await output('edge', '/docs/edge', 'shared12')),
        route: '/edge',
        parentOutputId: 'edge',
        groupId: 2,
      },
    ];
    const entries = [
      ENTRY,
      { id: 'edge', kind: 'app-page' as const, runtime: 'edge' as const, pathname: '/docs/edge' },
    ];
    const selected = await collect(inputs, { unshippedBodies: RANGE, entrypoints: entries });

    expect(selected.uploaded).toHaveLength(1);
    expect(selected.shipped.map(({ routes }) => routes)).toStrictEqual([['/docs/edge']]);
    expect(selected.prerenders[0]?.body).toStrictEqual(selected.prerenders[1]?.body);
  });

  it.each([
    { minBytes: 0, maxBytes: 16 },
    { minBytes: 16, maxBytes: 8 },
    { minBytes: 1.5, maxBytes: 16 },
    { minBytes: 8, maxBytes: Infinity },
  ])('refuses invalid ranges before writing any blobs: %j', async (range) => {
    const blobs = new BlobStore(directory);
    await blobs.init();

    await expect(
      collectPrerenders({
        outputs: {
          prerenders: await pair(),
          pages: [],
          appPages: [PAGE],
          appRoutes: [],
          pagesApi: [],
          staticFiles: [],
        },
        blobs,
        basePath: BASE_PATH,
        rsc: RSC,
        entrypoints: [ENTRY],
        unshippedBodies: range,
      }),
    ).rejects.toThrow('positive integer minBytes <= maxBytes');
    await expect(readdir(path.join(directory, 'blobs'))).resolves.toStrictEqual([]);
  });
});
