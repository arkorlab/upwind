/** Fixed whole-factory DATA from two clean offline public server-minification-off builds. */
import type {
  NodeManifestHandlerFingerprintRowData,
  NodeManifestHandlerImportData,
  NodeManifestHandlerReferenceGraphData,
  TargetData,
} from './node-manifest-handler-graph.ts';
import {
  HANDLER_UNMINIFIED_FACTORIES,
  HANDLER_UNMINIFIED_IDS,
} from './node-manifest-handler-unminified-factories.ts';
const streamSpecifier = 'node:stream';
const RUNTIME = 'next-16.4.3-public-pages-server-minification-off';
const nextRoot =
  '/work/node_modules/.pnpm/next@16.4.3_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next';
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
  const whole = HANDLER_UNMINIFIED_FACTORIES[factoryName];
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
export const HANDLER_UNMINIFIED_GRAPH: NodeManifestHandlerReferenceGraphData = {
  root: { runtime: RUNTIME, moduleId: HANDLER_UNMINIFIED_IDS.handler },
  nextRoot,
  rows: [
    row(
      'handler',
      HANDLER_UNMINIFIED_IDS.handler,
      'aaa3bb98bd0d3dc052410587a948b29fd93f78d436f3c8f6d2e02fae39ebf6e6',
      [
        internal('require', HANDLER_UNMINIFIED_IDS.crypto),
        internal('require', HANDLER_UNMINIFIED_IDS.path),
        internal('import', HANDLER_UNMINIFIED_IDS.noFallback),
        internal('import', HANDLER_UNMINIFIED_IDS.fresh),
        internal('import', HANDLER_UNMINIFIED_IDS.path),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('import', HANDLER_UNMINIFIED_IDS.escape),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.telemetry),
        internal('require', HANDLER_UNMINIFIED_IDS.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_UNMINIFIED_IDS.hoist,
      'f5206eb92dc20f49669d53b3f4f5680c32c7f5e7219759c139963960cac795b7',
      [
        internal('require', HANDLER_UNMINIFIED_IDS.crypto),
        internal('require', HANDLER_UNMINIFIED_IDS.path),
        internal('import', HANDLER_UNMINIFIED_IDS.noFallback),
        internal('import', HANDLER_UNMINIFIED_IDS.fresh),
        internal('import', HANDLER_UNMINIFIED_IDS.path),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('import', HANDLER_UNMINIFIED_IDS.escape),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.telemetry),
        internal('require', HANDLER_UNMINIFIED_IDS.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_UNMINIFIED_IDS.routeKind,
      'b757483d9bdb7596466c54218d9800578e16b118ec6eb76c5f2734501408362d',
      [
        internal('require', HANDLER_UNMINIFIED_IDS.crypto),
        internal('require', HANDLER_UNMINIFIED_IDS.path),
        internal('import', HANDLER_UNMINIFIED_IDS.noFallback),
        internal('import', HANDLER_UNMINIFIED_IDS.fresh),
        internal('import', HANDLER_UNMINIFIED_IDS.path),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('import', HANDLER_UNMINIFIED_IDS.escape),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.stream),
        internal('require', HANDLER_UNMINIFIED_IDS.telemetry),
        internal('require', HANDLER_UNMINIFIED_IDS.telemetryExternal),
      ],
    ),
    row(
      'noFallback',
      HANDLER_UNMINIFIED_IDS.noFallback,
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
      HANDLER_UNMINIFIED_IDS.fresh,
      '85b87b39e16e4ec38eeccc04ea551f4a961b3588aea75fbac8b0d3a41ccb921c',
      [],
    ),
    row(
      'path',
      HANDLER_UNMINIFIED_IDS.path,
      '72409d063712412d2e319a2896b8549cd03a53acb12adab4e012870fe515e39f',
      [external('path', { kind: 'builtin', id: 'path', aliases: ['path', 'node:path'] })],
    ),
    row(
      'stream',
      HANDLER_UNMINIFIED_IDS.stream,
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
      HANDLER_UNMINIFIED_IDS.escape,
      '0e937bbeac2e8ad16312d92704eff1fb346ff54b484c1273bee989ed6c55ec86',
      [],
    ),
    row(
      'telemetry',
      HANDLER_UNMINIFIED_IDS.telemetry,
      '773a0aba1981bcf99312917f6189e0123e1937e0999162e055d7af6fce8fe4f5',
      [],
    ),
    row(
      'telemetryExternal',
      HANDLER_UNMINIFIED_IDS.telemetryExternal,
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
      HANDLER_UNMINIFIED_IDS.crypto,
      'f17314affc1fbecec029556aa7f3ecd070a8ad15151f1265a05e1e23fc9e65f0',
      [external('crypto', { kind: 'builtin', id: 'crypto', aliases: ['crypto', 'node:crypto'] })],
    ),
  ],
};
