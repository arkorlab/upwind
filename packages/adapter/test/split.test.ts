import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RouteCode, ShippedBlob } from '../src/collect.ts';
import type { BuiltFunction } from '../src/function.ts';
import type { TextModule } from '../src/manifests.ts';
import type { PlannedFunction } from '../src/plan.ts';
import {
  carriesBlob,
  checkSplitOptions,
  everyFunction,
  manifestsOf,
  placedEntrypoints,
  placementsOf,
  planSplit,
  routesOf,
  type SplitInput,
  splitBudget,
} from '../src/split.ts';

/** When a build splits, on what budgets, and what each Function of a plan is given. */

const MIB = 1024 * 1024;
const HOST = { maxMiB: 40, maxCodeMiB: 16 };

function route(id: string): RouteCode {
  return {
    id,
    kind: 'app-page',
    module: undefined,
    edge: undefined,
    chunks: [],
    wasm: [],
    assets: {},
  };
}

function planned(name: string, ids: string[]): PlannedFunction {
  return { name, ids, bytes: 0, codeBytes: 0 };
}

function blob(routes: string[]): ShippedBlob {
  return { sha256: 'a'.repeat(64), bytes: new Uint8Array(1), routes };
}

describe('the budgets a build splits on', () => {
  it('are none where the host offers no split, whatever the project asks', () => {
    expect(splitBudget(undefined, true)).toBeUndefined();
    expect(splitBudget(undefined, { maxCodeMiB: 1 })).toBeUndefined();
  });

  it("are the host's, for every project, unless the host asks projects to opt in", () => {
    expect(splitBudget(HOST, undefined)).toStrictEqual({
      maxBytes: 40 * MIB,
      maxCodeBytes: 16 * MIB,
    });
    expect(splitBudget({ ...HOST, projects: 'opted-in' }, undefined)).toBeUndefined();
    expect(splitBudget({ ...HOST, projects: 'opted-in' }, true)).toStrictEqual({
      maxBytes: 40 * MIB,
      maxCodeBytes: 16 * MIB,
    });
  });

  it('are none for a project that turned the split off', () => {
    expect(splitBudget(HOST, false)).toBeUndefined();
  });

  it("can be tightened by the project, and never loosened past the host's", () => {
    expect(splitBudget(HOST, { maxCodeMiB: 8 })).toStrictEqual({
      maxBytes: 40 * MIB,
      maxCodeBytes: 8 * MIB,
    });
    expect(splitBudget(HOST, { maxMiB: 60, maxCodeMiB: 32 })).toStrictEqual({
      maxBytes: 40 * MIB,
      maxCodeBytes: 16 * MIB,
    });
  });

  it('refuse a host budget no Function could have', () => {
    expect(() => {
      checkSplitOptions({ maxMiB: 65, maxCodeMiB: 16 });
    }).toThrow(/maxMiB/u);
    expect(() => {
      checkSplitOptions({ maxMiB: 40, maxCodeMiB: 0 });
    }).toThrow(/maxCodeMiB/u);
    expect(() => {
      checkSplitOptions({ maxMiB: NaN, maxCodeMiB: 16 });
    }).toThrow(/maxMiB/u);
    expect(() => {
      checkSplitOptions(HOST);
    }).not.toThrow();
  });

  it('refuse a choice of projects that is neither', () => {
    expect(() => {
      checkSplitOptions({ ...HOST, projects: 'opted_in' as 'opted-in' });
    }).toThrow(/projects must be 'all' or 'opted-in', got "opted_in"/u);
    expect(() => {
      checkSplitOptions({ ...HOST, projects: 'opted-in' });
    }).not.toThrow();
  });
});

describe('what each Function of a plan holds', () => {
  const routes = ['/', '/a', '/b', '/_not-found', '/_middleware'].map((id) => route(id));
  const plan = [planned('app', ['/', '/a']), planned('app-2', ['/b'])];
  const placements = placementsOf(plan);

  it('places only the routes outside the first Function', () => {
    expect([...placements]).toStrictEqual([['/b', 'app-2']]);
    expect(
      placedEntrypoints(
        [
          { id: '/a', kind: 'app-page', pathname: '/a' },
          { id: '/b', kind: 'app-page', pathname: '/b' },
        ],
        placements,
      ),
    ).toStrictEqual([
      { id: '/a', kind: 'app-page', pathname: '/a' },
      { id: '/b', kind: 'app-page', pathname: '/b', function: 'app-2' },
    ]);
  });

  it('gives every Function the routes every Function carries', () => {
    const second = routesOf(plan[1] ?? planned('app-2', []), routes, placements, everyFunction(''));

    expect([...second].toSorted((a, b) => a.localeCompare(b, 'en'))).toStrictEqual([
      '/_middleware',
      '/_not-found',
      '/b',
    ]);
  });

  it('finds the error pages under the base path, where Next.js names them', () => {
    const based = ['/docs', '/docs/b', '/docs/_not-found', '/docs/404', '/_middleware'].map((id) =>
      route(id),
    );
    const second = routesOf(
      planned('app-2', ['/docs/b']),
      based,
      new Map([['/docs/b', 'app-2']]),
      everyFunction('/docs'),
    );

    expect([...second].toSorted((a, b) => a.localeCompare(b, 'en'))).toStrictEqual([
      '/_middleware',
      '/docs/_not-found',
      '/docs/404',
      '/docs/b',
    ]);
    expect(everyFunction('/docs').has('/_not-found')).toBe(false);
  });

  it('carries a blob where a route that names it is, and one no route names everywhere', () => {
    const known = new Set(routes.map((one) => one.id));

    expect(carriesBlob(blob(['/b']), new Set(['/b']), known)).toBe(true);
    expect(carriesBlob(blob(['/b']), new Set(['/a']), known)).toBe(false);
    expect(carriesBlob(blob(['/a', '/b']), new Set(['/b']), known)).toBe(true);
    // Weighed among what every Function carries, so carried by every one.
    expect(carriesBlob(blob(['/gone']), new Set(['/a']), known)).toBe(true);
    expect(carriesBlob(blob(['/gone']), new Set(['/b']), known)).toBe(true);
  });
});

/** A route's own client reference manifest, as the adapter collects it, read from under `dist`. */
function routeManifest(dist: string, page: string): TextModule {
  return {
    name: `.next/server/app${page}_client-reference-manifest.json`,
    contents: '{}',
    routeFile: path.join(dist, 'server', 'app', `${page}_client-reference-manifest.js`),
  };
}

/** A route whose trace names its own manifest, as Next.js traces every route module. */
function tracing(id: string, manifest: TextModule): RouteCode {
  return { ...route(id), assets: { [`manifest${id}`]: manifest.routeFile ?? '' } };
}

describe('the manifests each Function of a plan carries', () => {
  const dist = path.join(tmpdir(), 'split-manifests', '.next');
  const shared: TextModule = { name: '.next/routes-manifest.json', contents: '{}' };
  const notFound = routeManifest(dist, '/_not-found/page');
  const pageA = routeManifest(dist, '/a/page');
  const pageB = routeManifest(dist, '/b/page');
  const hooked = routeManifest(dist, '/hooked/page');
  // A route manifest no trace names: Next.js builds `_global-error` and the Pages Router's `_app`
  // whether or not an output of the build is theirs.
  const untraced = routeManifest(dist, '/_global-error/page');
  const manifests = [shared, notFound, pageA, pageB, hooked, untraced];
  const a = tracing('/a', pageA);
  const b = tracing('/b', pageB);
  const every = tracing('/_not-found', notFound);
  // What every Function holds besides its routes: the hook, whose trace names a manifest too.
  const hook = { assets: { 'hook-reads': hooked.routeFile ?? '' } };

  function carried(held: readonly RouteCode[]): string[] {
    return manifestsOf(manifests, [...held, hook], [a, b, every, hook]).map(
      (manifest) => manifest.name,
    );
  }

  it('are what every route reads, and of the routes’ own those of what it holds, in order', () => {
    expect(carried([a, every])).toStrictEqual(
      [shared, notFound, pageA, hooked, untraced].map((manifest) => manifest.name),
    );
    expect(carried([b, every])).toStrictEqual(
      [shared, notFound, pageB, hooked, untraced].map((manifest) => manifest.name),
    );
  });

  it('are all of them for a Function that holds every route', () => {
    expect(carried([a, b, every])).toStrictEqual(manifests.map((manifest) => manifest.name));
  });
});

/** A built Function as the planner reads one: its modules' sizes, and its code's by file. */
function builtWith(
  modules: readonly {
    readonly name: string;
    readonly type: 'commonjs' | 'esm' | 'text';
    readonly bytes: number;
  }[],
  inputs: BuiltFunction['inputs'],
): BuiltFunction {
  return {
    spec: {
      mainModule: 'index.mjs',
      modules: modules.map((module) => {
        return {
          name: module.name,
          type: module.type,
          blob: {
            sha256: 'a'.repeat(64),
            byteLength: module.bytes,
            contentType: 'text/javascript',
          },
        };
      }),
      compatibilityDate: '2026-09-15',
      compatibilityFlags: ['nodejs_compat'],
    },
    dependencies: {} as BuiltFunction['dependencies'],
    sourceMaps: [],
    inputs,
  };
}

/** A page whose trace names one chunk. */
function routeReading(id: string, chunk: string): RouteCode {
  return { ...route(id), assets: { [`chunk${id}`]: chunk } };
}

describe('a plan of routes that import linked packages', () => {
  const PACKAGE_A = 'pkg-a-0123456789abcdef/entry';
  const PACKAGE_B = 'pkg-b-0123456789abcdef/entry';

  /** Two pages, each of whose chunks imports a linked package of three MiB of its own. */
  async function linkedApplication(): Promise<SplitInput> {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'split-linked-'));
    const distDir = path.join(projectDir, '.next');
    const chunks = path.join(distDir, 'server', 'chunks');
    await mkdir(chunks, { recursive: true });
    const chunkA = path.join(chunks, 'a.js');
    const chunkB = path.join(chunks, 'b.js');
    await writeFile(chunkA, `module.exports = (t) => t.y("${PACKAGE_A}");`);
    await writeFile(chunkB, `module.exports = (t) => t.y("${PACKAGE_B}");`);
    return {
      routes: [routeReading('/a', chunkA), routeReading('/b', chunkB)],
      shipped: [],
      staticDigests: new Set(),
      manifests: [],
      single: builtWith(
        [
          { name: 'index.mjs', type: 'esm', bytes: 100 * 1024 },
          { name: 'app.cjs', type: 'commonjs', bytes: 200 * 1024 },
          { name: PACKAGE_A, type: 'esm', bytes: 3 * MIB },
          { name: PACKAGE_B, type: 'esm', bytes: 3 * MIB },
        ],
        [
          { file: chunkA, bytes: 50 * 1024 },
          { file: chunkB, bytes: 50 * 1024 },
        ],
      ),
      every: everyFunction(''),
      base: [],
      projectDir,
      distDir,
      budget: { maxBytes: 40 * MIB, maxCodeBytes: 4 * MIB },
    };
  }

  it('weighs each package with the routes that import it, not with what every Function carries', async () => {
    const plan = await planSplit(await linkedApplication());

    // Six MiB of packages between them, three with each page: in one Function they would be past
    // the code budget, and counted among what every Function carries they would leave no budget
    // to plan on at all.
    const code = plan.map((one) => one.codeBytes);

    expect(plan.map((one) => one.ids)).toStrictEqual([['/a'], ['/b']]);
    expect(code.every((bytes) => bytes > 3 * MIB && bytes < 4 * MIB)).toBe(true);
  });
});

/** A page whose trace names one chunk and the manifest its module reads. */
function routeReadingManifest(id: string, chunk: string, manifest: TextModule): RouteCode {
  return {
    ...route(id),
    assets: { [`chunk${id}`]: chunk, [`manifest${id}`]: manifest.routeFile ?? '' },
  };
}

/** Two pages, each with a little code and a manifest of three MiB that its module alone reads. */
async function manifestApplication(): Promise<SplitInput> {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'split-manifests-'));
  const distDir = path.join(projectDir, '.next');
  const chunks = path.join(distDir, 'server', 'chunks');
  await mkdir(chunks, { recursive: true });
  const chunkA = path.join(chunks, 'a.js');
  const chunkB = path.join(chunks, 'b.js');
  await writeFile(chunkA, 'module.exports = "a";');
  await writeFile(chunkB, 'module.exports = "b";');
  const manifestA = routeManifest(distDir, '/a/page');
  const manifestB = routeManifest(distDir, '/b/page');
  const shared = { name: '.next/routes-manifest.json', contents: '{}' };
  return {
    routes: [
      routeReadingManifest('/a', chunkA, manifestA),
      routeReadingManifest('/b', chunkB, manifestB),
    ],
    shipped: [],
    staticDigests: new Set(),
    manifests: [shared, manifestA, manifestB],
    single: builtWith(
      [
        { name: 'index.mjs', type: 'esm', bytes: 100 * 1024 },
        { name: 'app.cjs', type: 'commonjs', bytes: 200 * 1024 },
        { name: shared.name, type: 'text', bytes: 10 * 1024 },
        { name: manifestA.name, type: 'text', bytes: 3 * MIB },
        { name: manifestB.name, type: 'text', bytes: 3 * MIB },
      ],
      [
        { file: chunkA, bytes: 50 * 1024 },
        { file: chunkB, bytes: 50 * 1024 },
      ],
    ),
    every: everyFunction(''),
    base: [],
    projectDir,
    distDir,
    budget: { maxBytes: 5 * MIB, maxCodeBytes: 4 * MIB },
  };
}

describe('a plan of routes with manifests of their own', () => {
  it('weighs each manifest with its route, not with what every Function carries', async () => {
    const plan = await planSplit(await manifestApplication());

    // Six MiB of manifests between them, three with each page: in one Function they would be past
    // the size budget, and counted among what every Function carries they would leave it to no
    // Function at all, and the two pages would be planned into one.
    expect(plan.map((one) => one.ids)).toStrictEqual([['/a'], ['/b']]);
    expect(plan.every((one) => one.bytes > 3 * MIB && one.bytes < 3.5 * MIB)).toBe(true);
  });
});

/**
 * A page on the Node.js runtime and one on the edge runtime that both reach one module: bundled
 * into `app.cjs` for the first and `edge.cjs` for the second, two copies, each the code of the
 * route of its own runtime.
 */
async function bothRuntimes(): Promise<SplitInput> {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'split-runtimes-'));
  const distDir = path.join(projectDir, '.next');
  const chunks = path.join(distDir, 'server', 'chunks');
  await mkdir(chunks, { recursive: true });
  const shared = path.join(chunks, 'shared.js');
  await writeFile(shared, 'module.exports = 1;');
  const edge = {
    id: '/edge',
    entryKey: 'middleware_app/edge/page',
    handlerExport: 'handler',
    files: [shared],
    wasm: [],
    inlineAssets: [],
    env: {},
  };
  return {
    routes: [routeReading('/node', shared), { ...route('/edge'), edge }],
    shipped: [],
    staticDigests: new Set(),
    manifests: [],
    single: builtWith(
      [
        { name: 'index.mjs', type: 'esm', bytes: 64 * 1024 },
        { name: 'app.cjs', type: 'commonjs', bytes: 2 * MIB },
        { name: 'edge.cjs', type: 'commonjs', bytes: 2 * MIB },
      ],
      [
        { file: shared, bytes: 2 * MIB },
        { file: shared, bytes: 2 * MIB, edge: true },
      ],
    ),
    every: everyFunction(''),
    base: [],
    projectDir,
    distDir,
    budget: { maxBytes: 40 * MIB, maxCodeBytes: 3 * MIB },
  };
}

describe('a plan of routes on both runtimes', () => {
  it('weighs each bundle’s copy with the routes of its runtime', async () => {
    const plan = await planSplit(await bothRuntimes());

    // Two MiB each, three between them past the budget: each in a Function of its own, rather than
    // one copy left among what every Function carries and the budget dropped for it.
    expect(new Set(plan.map((one) => one.ids.join(',')))).toStrictEqual(
      new Set(['/edge', '/node']),
    );
  });
});
