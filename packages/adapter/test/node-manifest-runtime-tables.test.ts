import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import { certifyNodeManifestRuntimeCohort } from '../src/node-manifest-runtime-cohort.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import {
  nodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';
import {
  pagesContextGraph,
  CONTEXT_ENTRY,
  CONTEXT_RUNTIME,
} from './fixtures/node-manifest-pages-context.ts';
import { manifestTemplateSource as source } from './fixtures/node-manifest-turbopack-template.ts';

const ROOT = '/project';
const DIST = `${ROOT}/.next`;
const PAGE = `${DIST}/server/pages/native.js`;
const APP = `${DIST}/server/app/native/page.js`;
const PAGE_RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;
const APP_RUNTIME = `${DIST}/server/chunks/ssr/[turbopack]_runtime.js`;
const PAGE_TABLE = `${DIST}/server/chunks/pages.js`;
const APP_TABLE = `${DIST}/server/chunks/ssr/app.js`;
const LAZY_TABLE = `${DIST}/server/chunks/lazy.js`;
const LAST_TABLE = `${DIST}/server/chunks/last.js`;
const PROFILES = [
  { file: PAGE, pathname: '/native', kind: 'pages', assetPrefix: '/' },
  { file: APP, pathname: '/app-native', kind: 'app-page', assetPrefix: '/' },
] as const;

function boot(file: string, runtimeFile: string, chunk: string, id = 1): string {
  return `var R=require(${jsLiteral(path.posix.relative(path.posix.dirname(file), runtimeFile))})(${jsLiteral(path.posix.relative(DIST, file))});R.c(${jsLiteral(path.posix.relative(DIST, chunk))});module.exports=R.m(${id}).exports;`;
}
async function runtime(file: string): Promise<string> {
  return (await readFile(new URL('fixtures/node-runtime/production.txt', import.meta.url), 'utf8'))
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      () => `var RUNTIME_PUBLIC_PATH = ${jsLiteral(path.posix.relative(DIST, file))};`,
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
}
async function fixture(sharedTable = false) {
  const appTable = sharedTable ? PAGE_TABLE : APP_TABLE;
  const sources: NodeManifestTurbopackGraphFile[] = [
    {
      id: PAGE,
      file: PAGE,
      source: source(boot(PAGE, PAGE_RUNTIME, PAGE_TABLE)),
      imports: [{ specifier: '../chunks/[turbopack]_runtime.js', target: PAGE_RUNTIME }],
    },
    {
      id: APP,
      file: APP,
      source: source(boot(APP, APP_RUNTIME, appTable)),
      imports: [{ specifier: '../../chunks/ssr/[turbopack]_runtime.js', target: APP_RUNTIME }],
    },
    {
      id: PAGE_RUNTIME,
      file: PAGE_RUNTIME,
      source: source(await runtime(PAGE_RUNTIME)),
      imports: [PAGE_TABLE, APP_TABLE, PAGE_RUNTIME, APP_RUNTIME].map((target) => {
        return {
          specifier: target,
          target,
        };
      }),
    },
    {
      id: APP_RUNTIME,
      file: APP_RUNTIME,
      source: source(await runtime(APP_RUNTIME)),
      imports: [PAGE_TABLE, APP_TABLE, PAGE_RUNTIME, APP_RUNTIME].map((target) => {
        return {
          specifier: target,
          target,
        };
      }),
    },
    {
      id: PAGE_TABLE,
      file: PAGE_TABLE,
      source: source('module.exports=[1,ctx=>{ctx.v("pages");}];'),
      imports: [],
    },
    {
      id: APP_TABLE,
      file: APP_TABLE,
      source: source('module.exports=[1,ctx=>{ctx.v("app");}];'),
      imports: [],
    },
  ];
  return { sources, profiles: [...PROFILES] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function change(own: Fixture, file: string, code: string): Fixture {
  return {
    ...own,
    sources: own.sources.map((item) =>
      item.file === file ? { ...item, source: source(code) } : item,
    ),
  };
}
function table(own: Fixture, file: string, code: string, lookup = true): Fixture {
  return {
    ...own,
    sources: [
      ...own.sources.map((item) => {
        return lookup && item.file === PAGE_RUNTIME
          ? { ...item, imports: [...item.imports, { specifier: file, target: file }] }
          : item;
      }),
      { id: file, file, source: source(code), imports: [] },
    ],
  };
}
async function cohort(own: Fixture) {
  const inventory = await certifyNodeManifestRuntimeCallers({
    rootDir: ROOT,
    distDir: DIST,
    entries: own.profiles.map((profile) => {
      return {
        id: profile.pathname,
        canonicalFilePath: profile.file,
      };
    }),
    routes: own.profiles,
    entryTraces: [],
    sources: own.sources,
    retained: new Set(own.sources.map((item) => item.id)),
  });
  return certifyNodeManifestRuntimeCohort({
    ...own,
    inventory,
    rootDir: ROOT,
    distDir: DIST,
    requiredBoots: [PAGE, APP],
  });
}
async function graph(own: Fixture, file = PAGE) {
  return nodeManifestTurbopackBootGraph({
    distDir: DIST,
    sources: own.sources,
    file,
    runtimeCohort: await cohort(own),
  });
}
function lazy(id: number, target: number, chunk: string): string {
  return `${id},ctx=>{ctx.v(parentImport=>Promise.all([${jsLiteral(chunk)}].map(chunk=>ctx.l(chunk))).then(()=>parentImport(${target})));}`;
}

describe('source-bound per-runtime installation tables', () => {
  it('keeps colliding typed IDs in separately sealed runtime Maps', async () => {
    const own = await fixture();
    const pages = await graph(own);
    const app = await graph(own, APP);

    expect(
      pages.factories.map((item) => [item.projection.moduleId, item.physicalId]),
    ).toStrictEqual([[1, PAGE_TABLE]]);
    expect(app.factories.map((item) => [item.projection.moduleId, item.physicalId])).toStrictEqual([
      [1, APP_TABLE],
    ]);
    expect(pages.lookupTables).toStrictEqual([PAGE_TABLE, APP_TABLE]);
    expect(pages.exportedId).not.toBe(app.exportedId);
  });

  it('qualifies the same physical callback by its actual runtime identity', async () => {
    const own = await fixture(true);
    const pages = await graph(own);
    const app = await graph(own, APP);

    expect(pages.factories[0]?.physicalId).toBe(app.factories[0]?.physicalId);
    expect(pages.factories[0]?.id).not.toBe(app.factories[0]?.id);
  });

  it('seeds every certified owned boot of the same runtime', async () => {
    const own = await fixture();
    const input = change(own, APP, boot(APP, PAGE_RUNTIME, APP_TABLE, 2));
    const amended = change(input, APP_TABLE, 'module.exports=[2,ctx=>{ctx.v("app");}];');
    amended.sources = amended.sources.map((item) => {
      return item.file === APP
        ? {
            ...item,
            imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: PAGE_RUNTIME }],
          }
        : item;
    });
    const result = await graph(amended);

    expect(
      result.factories
        .map((item) => item.projection.moduleId)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toStrictEqual([1, 2]);
  });

  it('recursively admits every literal deferred loader table from installed factories', async () => {
    let own = change(
      await fixture(),
      PAGE_TABLE,
      `module.exports=[1,ctx=>{ctx.v(42);},${lazy(2, 3, 'server/chunks/lazy.js')}];`,
    );
    own = table(
      own,
      LAZY_TABLE,
      `module.exports=[3,ctx=>{ctx.v(43);},${lazy(4, 5, 'server/chunks/last.js')}];`,
    );
    own = table(own, LAST_TABLE, 'module.exports=[5,ctx=>{ctx.v(44);}];');
    const result = await graph(own);

    expect(result.factories.map((item) => item.physicalId)).toStrictEqual([
      PAGE_TABLE,
      PAGE_TABLE,
      LAZY_TABLE,
      LAZY_TABLE,
      LAST_TABLE,
    ]);
  });

  it.each(['server/chunks/missing.js', 'server/chunks/not-in-lookup.js', '../outside.js'])(
    'refuses missing, foreign or noncanonical deferred path %s',
    async (chunk) => {
      let own = change(
        await fixture(),
        PAGE_TABLE,
        `module.exports=[1,ctx=>{ctx.v(42);},${lazy(2, 3, chunk)}];`,
      );
      own = table(
        own,
        `${DIST}/server/chunks/not-in-lookup.js`,
        'module.exports=[3,ctx=>{ctx.v(43);}];',
        false,
      );

      await expect(graph(own)).rejects.toThrow('Unproved Next.js');
    },
  );

  it('never interprets another reviewed runtime as a table', async () => {
    const own = change(
      await fixture(),
      PAGE_TABLE,
      `module.exports=[1,ctx=>{ctx.v(42);},${lazy(2, 3, 'server/chunks/ssr/[turbopack]_runtime.js')}];`,
    );

    await expect(graph(own)).rejects.toThrow('runtime used as a table');
  });

  it.each(['ctx.l(dynamic);', 'ctx.A(dynamic);', 'ctx.i(999);'])(
    'retains refusal of unknown loader/module authority: %s',
    async (body) => {
      const own = change(await fixture(), PAGE_TABLE, `module.exports=[1,ctx=>{${body}}];`);

      await expect(graph(own)).rejects.toThrow('Unproved Next.js');
    },
  );

  it('keeps the complete old lookup inventory when an admitted callback exposes open chunk loading', async () => {
    const own = change(
      await fixture(),
      PAGE_TABLE,
      'module.exports=[1,ctx=>{const entry={loadChunk:ctx.l.bind(ctx)};ctx.v(entry);}];',
    );

    await expect(graph(own)).rejects.toThrow('duplicate module id across loaded chunks');
  });

  it.each([
    'module.exports=[1,ctx=>{ctx.v("pages");}];',
    'module.exports=[1,ctx=>{ctx.v("app");}];',
  ])('keeps byte-identical or different duplicate registrations strict: %s', async (code) => {
    const own = change(
      change(
        await fixture(),
        PAGE,
        boot(PAGE, PAGE_RUNTIME, PAGE_TABLE).replace(
          'module.exports=',
          'R.c("server/chunks/ssr/app.js");module.exports=',
        ),
      ),
      APP_TABLE,
      code,
    );

    await expect(graph(own)).rejects.toThrow('duplicate module id across loaded chunks');
  });

  it('preserves the old all-lookup interpretation without a certified cohort', async () => {
    const own = await fixture();

    expect(() =>
      nodeManifestTurbopackBootGraph({ distDir: DIST, sources: own.sources, file: PAGE }),
    ).toThrow('registration');
  });

  it.each(['source', 'imports', 'copy'])(
    'does not borrow a stale or copied cohort after %s mutation',
    async (mode) => {
      const own = await fixture();
      const seal = await cohort(own);
      const sources = own.sources.map((item) => {
        if (item.file !== PAGE_RUNTIME) return item;
        return mode === 'source'
          ? { ...item, source: source(`${item.source.code}\nchanged();`) }
          : { ...item, imports: item.imports.slice(1) };
      });

      expect(() => {
        return nodeManifestTurbopackBootGraph({
          distDir: DIST,
          sources: mode === 'copy' ? own.sources : sources,
          file: PAGE,
          runtimeCohort: mode === 'copy' ? { ...seal } : seal,
        });
      }).toThrow('runtime cohort');
    },
  );

  it('keeps lookup-only tables in the complete physical caller gate', async () => {
    const own = await pagesContextGraph();
    const lookup = `${DIST}/server/chunks/uninstalled.js`;
    const caller = `${ROOT}/customer.cjs`;
    const sources = [
      ...own.sources.map((item) => {
        return item.id === CONTEXT_RUNTIME
          ? { ...item, imports: [...item.imports, { specifier: lookup, target: lookup }] }
          : item;
      }),
      {
        id: lookup,
        file: lookup,
        source: source('module.exports=[1,ctx=>{ctx.v(0);}];'),
        imports: [],
      },
      {
        id: caller,
        file: caller,
        source: source('module.exports=require("./table");'),
        imports: [{ specifier: './table', target: lookup }],
      },
    ];
    const profiles = own.entries.map((entry) => {
      return {
        file: entry.file,
        pathname: entry.pathname,
        kind: 'pages' as const,
        assetPrefix: '/',
      };
    });
    const runtimeCallers = await certifyNodeManifestRuntimeCallers({
      rootDir: ROOT,
      distDir: DIST,
      entries: [{ id: '/blog/[slug]', canonicalFilePath: CONTEXT_ENTRY }],
      routes: profiles,
      entryTraces: [],
      sources,
      retained: new Set(sources.map((item) => item.id)),
    });

    await expect(
      proveNodeManifestTurbopackConsumers({
        ...own,
        sources,
        runtimeCallers,
        runtimeProfiles: profiles,
      }),
    ).rejects.toThrow('unknown physical factory-table caller');
  });
});
