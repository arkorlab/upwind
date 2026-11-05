/** Next.js 16.4.4: fixed whole-factory DATA from two clean offline public server-minification-off builds. */
import type {
  NodeManifestHandlerFingerprintRowData,
  NodeManifestHandlerImportData,
  NodeManifestHandlerReferenceGraphData,
  TargetData,
} from './node-manifest-handler-graph.ts';
import {
  HANDLER_UNMINIFIED_FACTORIES_16_4_4,
  HANDLER_UNMINIFIED_IDS_16_4_4,
} from './node-manifest-handler-unminified-16-4-4-factories.ts';
const streamSpecifier = 'node:stream';
const RUNTIME = 'next-16.4.4-public-pages-server-minification-off';
const nextRoot =
  '/work/node_modules/.pnpm/next@16.4.4_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next';
function internal(kind: 'import' | 'require', moduleId: number): NodeManifestHandlerImportData {
  return {
    kind,
    specifier: `turbopack:${moduleId}`,
    targetId: moduleId,
    target: { kind: 'module', runtime: RUNTIME, moduleId },
  };
}
function external(specifier: string, target: TargetData): NodeManifestHandlerImportData {
  return { kind: 'external', specifier, target };
}
function source(relative: string, sha256: string): TargetData {
  return { kind: 'next-source', root: nextRoot, relative, file: `${nextRoot}/${relative}`, sha256 };
}
function row(
  factoryName: string,
  moduleId: number,
  canonicalSha256: string,
  imports: readonly NodeManifestHandlerImportData[],
): NodeManifestHandlerFingerprintRowData {
  const whole = HANDLER_UNMINIFIED_FACTORIES_16_4_4[factoryName];
  if (whole?.factory.ids.includes(moduleId) !== true)
    throw new Error('Invalid fixed unminified handler reference row');
  return {
    mode: 'fingerprint',
    runtime: RUNTIME,
    moduleId,
    physicalId: whole.originalSha256,
    canonicalSha256,
    whole: { ...whole, selectedOrdinal: whole.factory.ids.indexOf(moduleId) },
    imports,
    operations: { cacheInitializers: [], asyncLoads: [], boundRuntimeInputs: [] },
  };
}
export const HANDLER_UNMINIFIED_GRAPH_16_4_4: NodeManifestHandlerReferenceGraphData = {
  root: { runtime: RUNTIME, moduleId: HANDLER_UNMINIFIED_IDS_16_4_4.handler },
  nextRoot,
  rows: [
    row(
      'handler',
      HANDLER_UNMINIFIED_IDS_16_4_4.handler,
      '39191958d16d33cd4933ebaff55637dc89927d86e7c23cea9bca07fe4d012cfb',
      [
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.crypto),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.path),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.noFallback),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.fresh),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.path),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.escape),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.telemetry),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_UNMINIFIED_IDS_16_4_4.hoist,
      '72d9733353a7ce3a242a6f1d60b5d55c39185f35bea0eb01face7fd373e642c5',
      [
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.crypto),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.path),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.noFallback),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.fresh),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.path),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.escape),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.telemetry),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_UNMINIFIED_IDS_16_4_4.routeKind,
      'a3cf075ec47a713bbcc3de062c5e1ff81e3558c3464d19ac04f706d41efb9224',
      [
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.crypto),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.path),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.noFallback),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.fresh),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.path),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('import', HANDLER_UNMINIFIED_IDS_16_4_4.escape),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.stream),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.telemetry),
        internal('require', HANDLER_UNMINIFIED_IDS_16_4_4.telemetryExternal),
      ],
    ),
    row(
      'noFallback',
      HANDLER_UNMINIFIED_IDS_16_4_4.noFallback,
      'd726a589de48f375531c5dbd1a45736c56a08df13bea0efaea952bdff2537647',
      [
        external(
          'next/dist/shared/lib/no-fallback-error.external.js',
          source(
            'dist/shared/lib/no-fallback-error.external.js',
            '2e641c2ce7efe466d03751134fefec1cfd752bb00060fc7273d6d6d26e723392',
          ),
        ),
      ],
    ),
    row(
      'fresh',
      HANDLER_UNMINIFIED_IDS_16_4_4.fresh,
      '85b87b39e16e4ec38eeccc04ea551f4a961b3588aea75fbac8b0d3a41ccb921c',
      [],
    ),
    row(
      'path',
      HANDLER_UNMINIFIED_IDS_16_4_4.path,
      '72409d063712412d2e319a2896b8549cd03a53acb12adab4e012870fe515e39f',
      [external('path', { kind: 'builtin', id: 'path', aliases: ['path', 'node:path'] })],
    ),
    row(
      'stream',
      HANDLER_UNMINIFIED_IDS_16_4_4.stream,
      '9769ab632f35abe111a7eb813d7655ec3feb6cb42a23089c6b9998ad59cd2174',
      [
        external(streamSpecifier, {
          kind: 'builtin',
          id: streamSpecifier,
          aliases: [streamSpecifier, 'stream'],
        }),
      ],
    ),
    row(
      'escape',
      HANDLER_UNMINIFIED_IDS_16_4_4.escape,
      '0e937bbeac2e8ad16312d92704eff1fb346ff54b484c1273bee989ed6c55ec86',
      [],
    ),
    row(
      'telemetry',
      HANDLER_UNMINIFIED_IDS_16_4_4.telemetry,
      '773a0aba1981bcf99312917f6189e0123e1937e0999162e055d7af6fce8fe4f5',
      [],
    ),
    row(
      'telemetryExternal',
      HANDLER_UNMINIFIED_IDS_16_4_4.telemetryExternal,
      '43583dae876f2f9c1a8980a6c381b753c2e72e12be1b22d8bb940fc47771b036',
      [
        external(
          'next/dist/compiled/@opentelemetry/api',
          source(
            'dist/compiled/@opentelemetry/api/index.js',
            '79cdf1ce026102bf94b8b9beb667d8c8635d0f702c2f118f441699684e92c2de',
          ),
        ),
      ],
    ),
    row(
      'crypto',
      HANDLER_UNMINIFIED_IDS_16_4_4.crypto,
      'f17314affc1fbecec029556aa7f3ecd070a8ad15151f1265a05e1e23fc9e65f0',
      [external('crypto', { kind: 'builtin', id: 'crypto', aliases: ['crypto', 'node:crypto'] })],
    ),
  ],
};
