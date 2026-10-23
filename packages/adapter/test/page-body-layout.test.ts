import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Entrypoint, FunctionModule } from '@stayingupwind/core/bundle';
import { AdapterOutputType } from 'next/dist/shared/lib/constants.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import { collectPrerenders, type PrerenderCollection, type ShippedBlob } from '../src/collect.ts';
import { AuditError, auditFunctionSize, type FunctionSize } from '../src/dependencies.ts';
import type { UnshippedPrerenderBodies } from '../src/page-bodies.ts';
import {
  type BodiesLeftOut,
  collectPageBodies,
  type PageBodyLayout,
  type PageBodyLayouts,
  withinTheLimit,
} from '../src/page-body-layout.ts';
import { carriesBlob } from '../src/split.ts';

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
const OVER_LIMIT: UnshippedPrerenderBodies = { ...RANGE, when: 'over-limit' };
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

/** Every blob a collection wrote, by digest. */
async function uploaded(outDir: string): Promise<{ sha256: string; bytes: Buffer }[]> {
  const blobs = path.join(outDir, 'blobs');
  const names = await readdir(blobs);
  return Promise.all(
    names
      .toSorted((left, right) => left.localeCompare(right))
      .map(async (sha256) => ({ sha256, bytes: await readFile(path.join(blobs, sha256)) })),
  );
}

describe('the page bodies a build starts from', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upwind-page-body-layout-'));
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

  /** A completed document and its whole Flight payload, both inside `RANGE`. */
  async function pair(): Promise<Output[]> {
    return [
      {
        ...(await output('document', '/docs/items/one', 'HTML1234')),
        routeType: 'page',
        response: 'complete',
        compute: 'static',
      },
      await output('flight', '/docs/items/one.rsc', 'opaqueFlight1234'),
    ];
  }

  /** What a build hands the collection, with an output directory of its own. */
  async function collection(
    prerenders: Output[],
    unshippedBodies: UnshippedPrerenderBodies | undefined,
  ): Promise<{ outDir: string; input: PrerenderCollection }> {
    const outDir = await mkdtemp(path.join(directory, 'bundle-'));
    const blobs = new BlobStore(outDir);
    await blobs.init();
    return {
      outDir,
      input: {
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
        unshippedBodies,
      },
    };
  }

  it('starts a range left to the limit as the build without the option', async () => {
    const inputs = await pair();
    const without = await collection(inputs, undefined);
    const ordinary = await collectPrerenders(without.input);
    const left = await collection(inputs, OVER_LIMIT);
    const { shippedOverLimit, ...first } = await collectPageBodies(left.input);

    expect(first).toStrictEqual({
      prerenders: ordinary.prerenders,
      shipped: ordinary.shipped,
      requireBundleBlobReader: false,
    });
    expect(first.shipped).toHaveLength(2);
    await expect(uploaded(left.outDir)).resolves.toStrictEqual(await uploaded(without.outDir));
    expect(shippedOverLimit).toBeTypeOf('function');
  });

  it('collects the fallback as the range applied to every build would collect it', async () => {
    const inputs = await pair();
    const always = await collection(inputs, RANGE);
    const omitted = await collectPrerenders(always.input);
    const left = await collection(inputs, OVER_LIMIT);
    const layouts = await collectPageBodies(left.input);

    expect(omitted.shipped).toStrictEqual([]);
    await expect(layouts.shippedOverLimit?.()).resolves.toStrictEqual(omitted.shipped);
    await expect(uploaded(left.outDir)).resolves.toStrictEqual(await uploaded(always.outDir));
  });

  it.each([
    { label: 'no range', range: undefined, reader: false },
    { label: 'a range', range: RANGE, reader: true },
    {
      label: 'a range for every build',
      range: { ...RANGE, when: 'always' as const },
      reader: true,
    },
  ])(
    'starts $label as it always has, with nothing left to the limit',
    async ({ range, reader }) => {
      const inputs = await pair();
      const direct = await collection(inputs, range);
      const expected = await collectPrerenders(direct.input);
      const own = await collection(inputs, range);

      await expect(collectPageBodies(own.input)).resolves.toStrictEqual({
        prerenders: expected.prerenders,
        shipped: expected.shipped,
        requireBundleBlobReader: reader,
        shippedOverLimit: undefined,
      });
    },
  );

  it('refuses a misspelt when before writing any blob', async () => {
    const misspelt = { ...RANGE, when: 'overLimit' } as unknown as UnshippedPrerenderBodies;
    const own = await collection(await pair(), misspelt);

    await expect(collectPageBodies(own.input)).rejects.toThrow(
      `unshippedPrerenderBodies.when must be 'always' or 'over-limit', got "overLimit"`,
    );
    await expect(readdir(path.join(own.outDir, 'blobs'))).resolves.toStrictEqual([]);
  });
});

const MIB = 1024 * 1024;

function shippedBlob(digit: string, byteLength: number): ShippedBlob {
  return { sha256: digit.repeat(64), bytes: new Uint8Array(byteLength), routes: [ROUTE] };
}

/** A body every layout ships, and two the range leaves out of a layout past the limit. */
const SMALL = shippedBlob('a', MIB / 2);
const LARGE = [shippedBlob('b', 2 * MIB), shippedBlob('c', 2 * MIB)];
const EVERY = [SMALL, ...LARGE];

function dataModule(name: string, byteLength: number): FunctionModule {
  return {
    name,
    type: 'data',
    blob: { sha256: '0'.repeat(64), byteLength, contentType: 'application/octet-stream' },
  };
}

/** What `layOutAppFunctions` answers, as far as `withinTheLimit` reads it. */
interface LaidOutFunctions {
  readonly built: readonly {
    readonly name: string;
    readonly built: {
      readonly spec: { readonly modules: readonly FunctionModule[] };
      readonly dependencies: { readonly size: FunctionSize };
    };
  }[];
  readonly bodiesLeftOut?: BodiesLeftOut | undefined;
}

/**
 * App Functions laid out as `layOutAppFunctions` lays them out, each with code of the size given and
 * the bodies of the layout `carries` gives it — by default, the last with every body the layout
 * ships; held to the limit as they are made, unless the layout is only to be weighed, as
 * `buildFunction` holds them (`deferSizeAudit`).
 */
function appFunctions(
  codeBytes: readonly number[],
  carries: (index: number, blob: ShippedBlob) => boolean = (index) =>
    index === codeBytes.length - 1,
) {
  const calls: { shipped: string[]; reader: boolean | undefined; weighOnly: boolean }[] = [];
  function layOut(layout: PageBodyLayout, weighOnly: boolean): Promise<LaidOutFunctions> {
    calls.push({
      shipped: layout.shipped.map((blob) => blob.sha256),
      reader: layout.requireBundleBlobReader,
      weighOnly,
    });
    const built = codeBytes.map((code, index) => {
      const name = index === 0 ? 'app' : `app-${String(index + 1)}`;
      const carried = layout.shipped.filter((blob) => carries(index, blob));
      const modules = [
        dataModule(`${name}.cjs`, code),
        ...carried.map((blob) => dataModule(`blobs/${blob.sha256}`, blob.bytes.byteLength)),
      ];
      const size = {
        bytes: modules.reduce((total, module) => total + module.blob.byteLength, 0),
        gzipBytes: 0,
      };
      auditFunctionSize(name, { modules, size }, weighOnly);
      return { name, built: { spec: { modules }, dependencies: { size } } };
    });
    return Promise.resolve({ built });
  }
  return { calls, layOut };
}

function leftToTheLimit(shippedOverLimit: () => Promise<readonly ShippedBlob[]>): PageBodyLayouts {
  return { shipped: EVERY, requireBundleBlobReader: false, shippedOverLimit };
}

describe('app Functions laid out within the size limit', () => {
  it('lays them out once, held to the limit as they are made, with nothing left to it', async () => {
    const { calls, layOut } = appFunctions([MIB]);

    await expect(withinTheLimit({ shipped: EVERY }, layOut)).resolves.not.toHaveProperty(
      'bodiesLeftOut',
    );
    expect(calls).toStrictEqual([
      { shipped: EVERY.map((blob) => blob.sha256), reader: undefined, weighOnly: false },
    ]);
  });

  it('fails a build past the limit as before when nothing was left to the limit', async () => {
    const { calls, layOut } = appFunctions([62 * MIB]);
    const laidOut = withinTheLimit({ shipped: EVERY, requireBundleBlobReader: false }, layOut);

    await expect(laidOut).rejects.toBeInstanceOf(AuditError);
    await expect(laidOut).rejects.toThrow(
      /^@stayingupwind\/adapter: the app server bundle is 66\.5 MiB, over the 64\.0 MiB limit; its largest modules are app\.cjs/u,
    );
    expect(calls).toHaveLength(1);
  });

  it('keeps a build within the limit exactly the build without the option', async () => {
    const fallback = vi.fn(() => Promise.resolve([SMALL]));
    const { calls, layOut } = appFunctions([MIB, 4 * MIB]);
    const laidOut = await withinTheLimit(leftToTheLimit(fallback), layOut);
    const without = await withinTheLimit({ shipped: EVERY }, appFunctions([MIB, 4 * MIB]).layOut);

    expect(laidOut).toStrictEqual(without);
    expect(calls).toStrictEqual([
      { shipped: EVERY.map((blob) => blob.sha256), reader: false, weighOnly: true },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('lays a build past the limit out again with the large bodies left out, and says so', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const { calls, layOut } = appFunctions([62 * MIB]);
    const laidOut = await withinTheLimit(
      leftToTheLimit(() => Promise.resolve([SMALL])),
      layOut,
    );

    expect(calls).toStrictEqual([
      { shipped: EVERY.map((blob) => blob.sha256), reader: false, weighOnly: true },
      { shipped: [SMALL.sha256], reader: true, weighOnly: false },
    ]);
    expect(laidOut.bodiesLeftOut).toStrictEqual({ count: 2, bytes: 4 * MIB });
    expect(laidOut.built[0]?.built.dependencies.size.bytes).toBe(62.5 * MIB);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        'the app server bundle is 66.5 MiB, over the 64.0 MiB limit. Building the app Functions again with 2 completed page bodies (4.0 MiB) left in bundle storage',
      ),
    );

    log.mockRestore();
  });

  it('fails a build the range does not bring under the limit as before', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const { calls, layOut } = appFunctions([64 * MIB]);
    const laidOut = withinTheLimit(
      leftToTheLimit(() => Promise.resolve([SMALL])),
      layOut,
    );

    await expect(laidOut).rejects.toBeInstanceOf(AuditError);
    await expect(laidOut).rejects.toThrow(
      /the app server bundle is 64\.5 MiB, over the 64\.0 MiB limit; its largest modules are/u,
    );
    expect(calls.map((call) => call.weighOnly)).toStrictEqual([true, false]);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('left in bundle storage'));

    log.mockRestore();
  });

  it('refuses a build with nothing to leave out without laying it out again', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const { calls, layOut } = appFunctions([MIB, 65 * MIB]);
    const laidOut = withinTheLimit(
      leftToTheLimit(() => Promise.resolve(EVERY)),
      layOut,
    );

    await expect(laidOut).rejects.toThrow(
      /^@stayingupwind\/adapter: the app-2 server bundle is 69\.5 MiB, over the 64\.0 MiB limit/u,
    );
    expect(calls.map((call) => call.weighOnly)).toStrictEqual([true]);
    expect(log).not.toHaveBeenCalled();

    log.mockRestore();
  });

  it('lays a split build out again when a body it leaves out is still shipped for another route', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    // Two routes name the same bytes, each held by a Function of its own; the range leaves the body
    // out for the route of the Function past the limit, and keeps it for the other.
    const other = '/docs/[slug]';
    const shared: ShippedBlob = { ...shippedBlob('d', 3 * MIB), routes: [other, ROUTE] };
    const held = [new Set([other]), new Set([ROUTE])];
    const known = new Set([other, ROUTE]);
    const { calls, layOut } = appFunctions([MIB, 62 * MIB], (index, blob) =>
      carriesBlob(blob, held[index] ?? new Set(), known),
    );
    const laidOut = await withinTheLimit(
      {
        shipped: [shared],
        requireBundleBlobReader: false,
        shippedOverLimit: () => Promise.resolve([{ ...shared, routes: [other] }]),
      },
      layOut,
    );

    expect(calls.map((call) => call.weighOnly)).toStrictEqual([true, false]);
    expect(laidOut.built.map(({ built }) => built.dependencies.size.bytes)).toStrictEqual([
      4 * MIB,
      62 * MIB,
    ]);
    expect(laidOut.bodiesLeftOut).toStrictEqual({ count: 1, bytes: 3 * MIB });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        'the app-2 server bundle is 65.0 MiB, over the 64.0 MiB limit. Building the app Functions again with 1 completed page body (3.0 MiB) left in bundle storage',
      ),
    );

    log.mockRestore();
  });

  it('refuses at once a build whose bodies the range leaves out are files every Function carries', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const { calls, layOut } = appFunctions([62 * MIB]);
    const laidOut = withinTheLimit(
      {
        ...leftToTheLimit(() => Promise.resolve([SMALL])),
        // The large bodies have the bytes of files the Functions answer themselves.
        staticBlobs: LARGE.map(({ sha256 }) => ({ sha256 })),
      },
      layOut,
    );

    await expect(laidOut).rejects.toThrow(
      /^@stayingupwind\/adapter: the app server bundle is 66\.5 MiB, over the 64\.0 MiB limit/u,
    );
    expect(calls.map((call) => call.weighOnly)).toStrictEqual([true]);
    expect(log).not.toHaveBeenCalled();

    log.mockRestore();
  });
});
