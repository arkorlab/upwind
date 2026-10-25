import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  inspectNodeManifestTurbopackEntry,
  nodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';

const DIST = '/project/.next';
const ENTRY = '/project/.next/server/app/native/page.js';
const CHUNK = '/project/.next/server/chunks/app.js';
const RUNTIME = '/project/.next/server/chunks/[turbopack]_runtime.js';
const PRODUCER = '/project/node_modules/next/dist/build/templates/app-page-runtime.js';
const SPECIFIER = 'next/dist/build/templates/app-page-runtime.js';
const BOOT = [
  'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/native/page.js");',
  'R.c("server/chunks/app.js");',
  'R.m(1);',
  'module.exports=R.m(1).exports;',
].join('\n');

function source(code: string): { readonly code: string; readonly sha256: string } {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

function fixture(): {
  readonly distDir: string;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly entry: { readonly file: string; readonly page: string; readonly pathname: string };
} {
  return {
    distDir: DIST,
    entry: { file: ENTRY, page: '/native/page', pathname: '/native' },
    sources: [
      {
        id: ENTRY,
        file: ENTRY,
        source: source(BOOT),
        imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: RUNTIME }],
      },
      {
        id: RUNTIME,
        file: RUNTIME,
        source: source('module.exports=unprovedRuntime;'),
        imports: [{ specifier: CHUNK, target: CHUNK }],
      },
      {
        id: CHUNK,
        file: CHUNK,
        source: source(
          `module.exports=[1,((ctx)=>{var p=ctx.i(2);ctx.n(p);}),2,((ctx)=>{var p=ctx.x(${JSON.stringify(SPECIFIER)},()=>require(${JSON.stringify(SPECIFIER)}));ctx.n(p);})];`,
        ),
        imports: [{ specifier: SPECIFIER, target: PRODUCER }],
      },
      { id: PRODUCER, file: PRODUCER, source: source('exports.placeholder=1;'), imports: [] },
    ],
  };
}

function replaceFile(
  own: ReturnType<typeof fixture>,
  file: string,
  code: string,
): ReturnType<typeof fixture> {
  return {
    ...own,
    sources: own.sources.map((record) =>
      record.file === file ? { ...record, source: source(code) } : record,
    ),
  };
}

describe('next Turbopack route topology', () => {
  it('recognizes the complete fixed entry producer without executing its runtime', () => {
    expect(inspectNodeManifestTurbopackEntry(source(BOOT))).toStrictEqual({
      runtimeSpecifier: '../../chunks/[turbopack]_runtime.js',
      publicPath: 'server/app/native/page.js',
      chunks: ['server/chunks/app.js'],
      evaluations: [1],
      exportedId: 1,
    });
  });

  it('binds individual module IDs to actual external resolutions and keeps both proof obligations open', () => {
    const own = fixture();
    const graph = nodeManifestTurbopackEntryGraph(own);

    expect({
      physical: graph.physicalId,
      exported: graph.exportedId,
      evaluations: graph.evaluations,
      modules: graph.factories.map((factory) => ({
        id: factory.id,
        physical: factory.physicalId,
        imports: factory.imports,
      })),
      runtime: graph.runtime.source,
      runtimeProof: graph.requiresReviewedRuntime,
      normalization: graph.requiresSdkNormalization,
    }).toStrictEqual({
      physical: ENTRY,
      exported: `${CHUNK}#turbopack:1`,
      evaluations: [`${CHUNK}#turbopack:1`],
      modules: [
        {
          id: `${CHUNK}#turbopack:1`,
          physical: CHUNK,
          imports: [{ specifier: 'turbopack:2', target: `${CHUNK}#turbopack:2` }],
        },
        {
          id: `${CHUNK}#turbopack:2`,
          physical: CHUNK,
          imports: [{ specifier: SPECIFIER, target: PRODUCER }],
        },
      ],
      runtime: own.sources[1]?.source,
      runtimeProof: true,
      normalization: true,
    });
  });

  it.each([
    ['extra statement', `${BOOT}\nglobalThis.sideEffect();`],
    ['bootstrap alias', BOOT.replace('var R=', 'var Other=')],
    ['runtime receiver escape', BOOT.replace('R.c(', 'escaped(R);R.c(')],
    ['dynamic runtime require', BOOT.replace('"../../chunks/[turbopack]_runtime.js"', 'dynamic')],
    ['dynamic entry path', BOOT.replace('"server/app/native/page.js"', 'dynamic')],
    ['escaping chunk path', BOOT.replace('"server/chunks/app.js"', '"../../outside.js"')],
    ['absolute chunk path', BOOT.replace('"server/chunks/app.js"', '"/outside.js"')],
    ['chunk after evaluation', BOOT.replace('R.m(1);', 'R.m(1);R.c("server/chunks/late.js");')],
    ['dynamic evaluation ID', BOOT.replace('R.m(1);', 'R.m(dynamic);')],
    ['alternate export', BOOT.replace('module.exports=', 'module.other=')],
    ['changed export selector', BOOT.replace('.exports;', '.handler;')],
    ['optional call', BOOT.replace('R.m(1).exports', 'R.m?.(1).exports')],
  ])('refuses %s instead of using a filename as route proof', (_name, code) => {
    expect(() => inspectNodeManifestTurbopackEntry(source(code))).toThrow(
      'Unproved Next.js Turbopack consumer graph',
    );
  });

  it.each([
    [
      'route public path mismatch',
      (own: ReturnType<typeof fixture>) =>
        replaceFile(
          own,
          ENTRY,
          BOOT.replace('server/app/native/page.js', 'server/app/other/page.js'),
        ),
    ],
    [
      'missing physical chunk',
      (own: ReturnType<typeof fixture>) => ({
        ...own,
        sources: own.sources.filter((record) => record.file !== CHUNK),
      }),
    ],
    [
      'missing runtime edge',
      (own: ReturnType<typeof fixture>) => ({
        ...own,
        sources: own.sources.map((record) =>
          record.file === RUNTIME ? { ...record, imports: [] } : record,
        ),
      }),
    ],
    [
      'missing actual external edge',
      (own: ReturnType<typeof fixture>) => ({
        ...own,
        sources: own.sources.map((record) =>
          record.file === CHUNK ? { ...record, imports: [] } : record,
        ),
      }),
    ],
    [
      'unproved deferred table target',
      (own: ReturnType<typeof fixture>) => ({
        ...own,
        sources: own.sources.map((record) =>
          record.file === RUNTIME
            ? {
                ...record,
                imports: [
                  ...record.imports,
                  {
                    specifier: '/project/.next/server/chunks/absent.js',
                    target: '/project/.next/server/chunks/absent.js',
                  },
                ],
              }
            : record,
        ),
      }),
    ],
    [
      'unregistered exported module',
      (own: ReturnType<typeof fixture>) =>
        replaceFile(own, ENTRY, BOOT.replace('module.exports=R.m(1)', 'module.exports=R.m(9)')),
    ],
    [
      'missing initial chunk registration',
      (own: ReturnType<typeof fixture>) =>
        replaceFile(own, ENTRY, BOOT.replace('R.c("server/chunks/app.js");', '')),
    ],
    [
      'unregistered imported module',
      (own: ReturnType<typeof fixture>) =>
        replaceFile(own, CHUNK, 'module.exports=[1,((ctx)=>{var p=ctx.i(9);ctx.n(p);})];'),
    ],
    [
      'changed source hash',
      (own: ReturnType<typeof fixture>) => ({
        ...own,
        sources: own.sources.map((record) =>
          record.file === CHUNK
            ? { ...record, source: { ...record.source, sha256: 'a'.repeat(64) } }
            : record,
        ),
      }),
    ],
    [
      'duplicate source identity',
      (own: ReturnType<typeof fixture>) => ({ ...own, sources: [...own.sources, own.sources[0]!] }),
    ],
    [
      'factory metadata collision',
      (own: ReturnType<typeof fixture>) => ({
        ...own,
        sources: [
          ...own.sources,
          {
            id: `${CHUNK}#turbopack:1`,
            file: '/project/collision.js',
            source: source('module.exports=1;'),
            imports: [],
          },
        ],
      }),
    ],
  ])('refuses %s before exposing virtual module metadata', (_name, change) => {
    expect(() => nodeManifestTurbopackEntryGraph(change(fixture()))).toThrow(
      'Unproved Next.js Turbopack',
    );
  });
});
