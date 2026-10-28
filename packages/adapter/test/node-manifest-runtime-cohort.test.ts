import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import {
  certifyNodeManifestRuntimeCohort,
  nodeManifestRuntimeCohortSources,
  prepareNodeManifestRuntimeGraphs,
  type NodeManifestRuntimeProfile,
} from '../src/node-manifest-runtime-cohort.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import type { NodeManifestTurbopackGraphFile } from '../src/node-manifest-turbopack-graph.ts';
import {
  manifestTemplateSource as source,
  projectedTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

const ROOT = '/project';
const DIST = `${ROOT}/.next`;
const ENTRY = `${DIST}/server/pages/blog/[slug].js`;
const API = `${DIST}/server/pages/api/native.js`;
const RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;
const API_RUNTIME = `${DIST}/server/chunks/ssr/[turbopack]_runtime.js`;
const CHUNK = `${DIST}/server/chunks/app.js`;
const PREFIX = 'https://cdn.example/assets/_next/';
const PROFILES: readonly NodeManifestRuntimeProfile[] = [
  { file: ENTRY, pathname: '/blog/[slug]', kind: 'pages', assetPrefix: PREFIX },
  { file: API, pathname: '/api/native', kind: 'pages-api', assetPrefix: '/' },
];
const ENTRIES = [
  { file: ENTRY, page: '/blog/[slug]', pathname: '/blog/[slug]', kind: 'pages' },
] as const;

function boot(file: string, runtimeFile: string, id: number): string {
  return `var R=require(${jsLiteral(path.posix.relative(path.posix.dirname(file), runtimeFile))})(${jsLiteral(path.posix.relative(DIST, file))});R.c("server/chunks/app.js");R.m(${id});module.exports=R.m(${id}).exports;`;
}
async function runtime(file: string, prefix: string): Promise<string> {
  const original = await readFile(
    new URL('fixtures/node-runtime/production.txt', import.meta.url),
    'utf8',
  );
  return original
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      () => `var RUNTIME_PUBLIC_PATH = ${jsLiteral(path.posix.relative(DIST, file))};`,
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";')
    .replace('var ASSET_PREFIX = "/";', () => `var ASSET_PREFIX = ${jsLiteral(prefix)};`);
}
function imports(file: string, target: string) {
  return [{ specifier: path.posix.relative(path.posix.dirname(file), target), target }];
}
async function inventory(sources: readonly NodeManifestTurbopackGraphFile[]) {
  return certifyNodeManifestRuntimeCallers({
    rootDir: ROOT,
    distDir: DIST,
    entries: PROFILES.map((profile) => ({ id: profile.pathname, canonicalFilePath: profile.file })),
    routes: PROFILES,
    entryTraces: [],
    sources,
    retained: new Set(sources.map((item) => item.id)),
  });
}
async function fixture() {
  const sources: NodeManifestTurbopackGraphFile[] = [
    {
      id: ENTRY,
      file: ENTRY,
      source: source(boot(ENTRY, RUNTIME, 1)),
      imports: imports(ENTRY, RUNTIME),
    },
    {
      id: API,
      file: API,
      source: source(boot(API, API_RUNTIME, 9)),
      imports: imports(API, API_RUNTIME),
    },
    {
      id: RUNTIME,
      file: RUNTIME,
      source: source(await runtime(RUNTIME, PREFIX)),
      imports: [
        { specifier: CHUNK, target: CHUNK },
        { specifier: RUNTIME, target: RUNTIME },
        { specifier: API_RUNTIME, target: API_RUNTIME },
      ],
    },
    {
      id: API_RUNTIME,
      file: API_RUNTIME,
      source: source(await runtime(API_RUNTIME, '/')),
      imports: [
        { specifier: CHUNK, target: CHUNK },
        { specifier: RUNTIME, target: RUNTIME },
        { specifier: API_RUNTIME, target: API_RUNTIME },
      ],
    },
    {
      id: CHUNK,
      file: CHUNK,
      source: source('module.exports=[1,(ctx)=>{ctx.v(42);},9,(ctx)=>{ctx.v(43);}];'),
      imports: [],
    },
  ];
  return {
    sources,
    inventory: await inventory(sources),
    profiles: PROFILES,
    requiredBoots: [ENTRY],
    rootDir: ROOT,
    distDir: DIST,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function edit(input: Fixture, file: string, change: (code: string) => string): Fixture {
  return {
    ...input,
    sources: input.sources.map((item) =>
      item.file === file ? { ...item, source: source(change(item.source.code)) } : item,
    ),
  };
}
function prepare(input: Fixture) {
  return prepareNodeManifestRuntimeGraphs({ ...input, entries: ENTRIES, assetPrefix: PREFIX });
}
async function pages(input: Fixture) {
  const template = await projectedTemplateFixture('pages');
  const callback = template.projection.original.code.slice(
    template.projection.factory.start,
    template.projection.factory.end,
  );
  const slots = [
    ...new Set(
      template.projection.imports.flatMap((item) =>
        item.targetId === undefined ? [] : [item.targetId],
      ),
    ),
  ]
    .map((id) => `${jsLiteral(id)},(ctx)=>{ctx.s(["default",()=>value]);const value={};},`)
    .join('');
  const external = template.imports.filter((item) => !item.specifier.startsWith('turbopack:'));
  const producer = external.find((item) => item.file.endsWith('/pages/module.compiled.js'));
  if (producer === undefined) throw new Error('Expected the pinned Pages constructor');
  const changed = edit(
    input,
    CHUNK,
    () => `module.exports=[${slots}1,${callback},9,(ctx)=>{ctx.v(43);}];`,
  );
  const sources = [
    ...changed.sources.map((item) => {
      return item.file === CHUNK
        ? {
            ...item,
            imports: external.map((dependency) => {
              return {
                specifier: dependency.specifier,
                target: dependency.file,
              };
            }),
          }
        : item;
    }),
    ...(await Promise.all(
      external.map(async (item) => {
        return {
          id: item.file,
          file: item.file,
          source: source(await readFile(item.file, 'utf8')),
          imports: [],
        };
      }),
    )),
  ];
  return {
    rootDir: ROOT,
    distDir: DIST,
    sources,
    entries: ENTRIES,
    assetPrefix: PREFIX,
    runtimeCallers: input.inventory,
    runtimeProfiles: input.profiles,
    producer: {
      id: producer.file,
      file: producer.file,
      sha256: producer.sha256,
      kind: 'pages-class',
    } as const,
  };
}

describe('owned mixed runtime cohort', () => {
  it('seals distinct runtime profiles before interpreting tables and keeps the extra boot generic', async () => {
    const input = await fixture();
    const proof = prepare(input);

    expect(
      nodeManifestRuntimeCohortSources(certifyNodeManifestRuntimeCohort(input), input.sources).map(
        (item) => ({ file: item.file, prefix: item.assetPrefix }),
      ),
    ).toStrictEqual([
      { file: RUNTIME, prefix: PREFIX },
      { file: API_RUNTIME, prefix: '/' },
    ]);
    expect(proof.graphs.map((graph) => graph.entry.file)).toStrictEqual([ENTRY]);
    expect(proof.allGraphs.map((graph) => graph.physicalId)).toStrictEqual([ENTRY, API]);
    expect(proof.allGraphs[1]).not.toHaveProperty('entry');
    expect(proof.allGraphs[1]).not.toHaveProperty('requiresSdkNormalization');
  });

  it('closes a real protected Pages template while the other-kind boot remains caller-only', async () => {
    const proof = await proveNodeManifestTurbopackConsumers(await pages(await fixture()));

    expect(proof.terminals.map((terminal) => terminal.file)).toStrictEqual([ENTRY]);
    expect(proof.compilerSources.map((item) => item.file)).toStrictEqual([RUNTIME, API_RUNTIME]);
    expect(proof.files.map((item) => item.file)).toStrictEqual(
      expect.arrayContaining([ENTRY, API, RUNTIME, API_RUNTIME, CHUNK]),
    );
  });

  it.each(["'use strict';", '"use strict";'])(
    'preserves the owned additional boot grammar with directive %s',
    async (directive) => {
      const input = edit(await fixture(), API, (code) => `${directive}${code}`);
      const owned = { ...input, inventory: await inventory(input.sources) };
      const proof = await proveNodeManifestTurbopackConsumers(await pages(owned));

      expect(proof.terminals.map((terminal) => terminal.file)).toStrictEqual([ENTRY]);
      expect(proof.compilerSources.map((item) => item.file)).toStrictEqual([RUNTIME, API_RUNTIME]);
    },
  );

  it('does not grant runtime identity to an unknown prefixed caller shape', async () => {
    const input = edit(await fixture(), API, (code) => `unknown();${code}`);
    const owned = { ...input, inventory: await inventory(input.sources) };

    const prepared = prepare(owned);

    expect(prepared.allGraphs.map((graph) => graph.runtimeId)).not.toContain(API_RUNTIME);
    expect(
      prepared.allGraphs.flatMap((graph) => graph.factories.map((factory) => factory.physicalId)),
    ).not.toContain(API_RUNTIME);
    await expect(proveNodeManifestTurbopackConsumers(await pages(owned))).rejects.toThrow(
      'unknown physical factory-table caller',
    );
  });

  it.each(['body', 'prefix'] as const)('refuses a changed other-kind runtime %s', async (mode) => {
    const input = edit(await fixture(), API_RUNTIME, (code) => {
      return mode === 'body'
        ? `${code}\nunknown();`
        : code.replace('var ASSET_PREFIX = "/";', 'var ASSET_PREFIX = "wrong";');
    });

    expect(() => prepare(input)).toThrow('Unproved Next.js Turbopack runtime');
  });

  it('requires a sealed kind for every admitted owned boot, including an otherwise byte-reviewed runtime', async () => {
    const input = await fixture();

    expect(() => prepare({ ...input, profiles: PROFILES.slice(0, 1) })).toThrow(
      'unsealed boot producer profile',
    );
  });

  it('does not treat copied cohorts or changed source/actual-edge bindings as authority', async () => {
    const input = await fixture();
    const cohort = certifyNodeManifestRuntimeCohort(input);
    const changed = input.sources.map((item) =>
      item.file === API_RUNTIME ? { ...item, imports: [] } : item,
    );

    expect(() => nodeManifestRuntimeCohortSources({ ...cohort }, input.sources)).toThrow(
      'uncertified cohort',
    );
    expect(() => nodeManifestRuntimeCohortSources(cohort, changed)).toThrow(
      'cohort source binding',
    );
    expect(() =>
      certifyNodeManifestRuntimeCohort({ ...input, inventory: { ...input.inventory } }),
    ).toThrow('uncertified caller inventory');
  });

  it('does not classify an unowned byte-reviewed runtime as a table exemption', async () => {
    const input = await fixture();
    const file = `${DIST}/server/chunks/foreign/[turbopack]_runtime.js`;
    const sources = [
      ...input.sources.map((item) => {
        return item.id === RUNTIME
          ? { ...item, imports: [...item.imports, { specifier: file, target: file }] }
          : item;
      }),
      {
        id: file,
        file,
        source: source(await runtime(file, '/')),
        imports: [{ specifier: CHUNK, target: CHUNK }],
      },
    ];

    const prepared = prepare({ ...input, sources });

    expect(prepared.cohort?.runtimes.map((identity) => identity.id)).not.toContain(file);
    expect(prepared.allGraphs.flatMap((graph) => graph.lookupTables ?? [])).toContain(file);
    expect(
      prepared.allGraphs.flatMap((graph) => graph.factories.map((factory) => factory.physicalId)),
    ).not.toContain(file);
    await expect(
      proveNodeManifestTurbopackConsumers(await pages({ ...input, sources })),
    ).rejects.toThrow('unknown physical factory-table caller');
  });

  it('requires the exact absolute compiler lookup edge between reviewed runtime sources', async () => {
    const input = await fixture();
    const sources = input.sources.map((item) => {
      return item.id === RUNTIME
        ? {
            ...item,
            imports: item.imports.map((edge) =>
              edge.target === API_RUNTIME ? { ...edge, specifier: './ssr/runtime' } : edge,
            ),
          }
        : item;
    });

    expect(() => prepare({ ...input, sources })).toThrow('unproved cross-runtime lookup edge');
  });

  it.each([RUNTIME, API_RUNTIME])(
    'refuses an explicit initial R.c load of reviewed runtime %s',
    async (target) => {
      const input = edit(await fixture(), ENTRY, (code) => {
        return code.replace(
          'R.c("server/chunks/app.js");',
          () => `R.c(${jsLiteral(path.posix.relative(DIST, target))});`,
        );
      });
      const owned = { ...input, inventory: await inventory(input.sources) };

      expect(() => prepare(owned)).toThrow('runtime used as a factory table');
    },
  );

  it('still refuses an unknown physical caller of the other reviewed runtime', async () => {
    const input = await pages(await fixture());
    const file = `${ROOT}/unknown.js`;
    const sources = [
      ...input.sources,
      {
        id: file,
        file,
        source: source(`require(${jsLiteral(API_RUNTIME)});`),
        imports: [{ specifier: API_RUNTIME, target: API_RUNTIME }],
      },
    ];

    await expect(proveNodeManifestTurbopackConsumers({ ...input, sources })).rejects.toThrow(
      'unknown runtime API caller',
    );
  });

  it('does not let the additional runtime boot become a protected Pages terminal', async () => {
    const input = edit(await fixture(), API, (code) => code.replaceAll('R.m(9)', 'R.m(1)'));
    const owned = { ...input, inventory: await inventory(input.sources) };

    await expect(proveNodeManifestTurbopackConsumers(await pages(owned))).rejects.toThrow(
      'consumer without a sealed route',
    );
  });

  it('keeps every unused ordinary table factory under the original context audit', async () => {
    const input = edit(await fixture(), CHUNK, (code) =>
      code.replace('module.exports=[', 'module.exports=[99,(ctx)=>{ctx.unknown();},'),
    );

    expect(() => prepare(input)).toThrow('Unproved Next.js Turbopack');
  });
});
