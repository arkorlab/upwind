/** Fixed reference DATA from the marker-free, independently compiled public Pages fixture. */
import type {
  NodeManifestHandlerFingerprintRowData,
  NodeManifestHandlerImportData,
  NodeManifestHandlerReferenceGraphData,
  TargetData,
} from './node-manifest-handler-graph.ts';
import {
  HANDLER_REFERENCE_FACTORIES,
  HANDLER_REFERENCE_IDS,
} from './node-manifest-handler-reference-factories.ts';

const HANDLER_REFERENCE_RUNTIME = 'next-16.4.3-public-pages';
const streamSpecifier = 'node:stream';
const nextRoot =
  '/work/node_modules/.pnpm/next@16.4.3_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next';

function internal(kind: 'import' | 'require', moduleId: number): NodeManifestHandlerImportData {
  return {
    kind,
    specifier: `turbopack:${moduleId}`,
    targetId: moduleId,
    target: { kind: 'module', runtime: HANDLER_REFERENCE_RUNTIME, moduleId },
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
  const whole = HANDLER_REFERENCE_FACTORIES[factoryName];
  if (whole === undefined || !whole.factory.ids.includes(moduleId))
    throw new Error('Invalid fixed handler reference row');
  return {
    mode: 'fingerprint',
    runtime: HANDLER_REFERENCE_RUNTIME,
    moduleId,
    physicalId: whole.originalSha256,
    canonicalSha256,
    whole: { ...whole, selectedOrdinal: whole.factory.ids.indexOf(moduleId) },
    imports,
    operations: { cacheInitializers: [], asyncLoads: [], boundRuntimeInputs: [] },
  };
}

export const HANDLER_REFERENCE_GRAPH: NodeManifestHandlerReferenceGraphData = {
  root: { runtime: HANDLER_REFERENCE_RUNTIME, moduleId: HANDLER_REFERENCE_IDS.handler },
  nextRoot,
  rows: [
    row(
      'handler',
      HANDLER_REFERENCE_IDS.handler,
      '2b1abeb9e15881f86d8547f329a9b21bcb0de28209eef830618acca01e0da669',
      [
        internal('import', HANDLER_REFERENCE_IDS.noFallback),
        internal('import', HANDLER_REFERENCE_IDS.fresh),
        internal('import', HANDLER_REFERENCE_IDS.path),
        internal('require', HANDLER_REFERENCE_IDS.stream),
        internal('require', HANDLER_REFERENCE_IDS.stream),
        internal('import', HANDLER_REFERENCE_IDS.escape),
        internal('require', HANDLER_REFERENCE_IDS.telemetry),
        internal('require', HANDLER_REFERENCE_IDS.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_REFERENCE_IDS.hoist,
      'f8a3d7daad21cac0a394412473b84139e1f517592ce495a780ee56db29c9db3c',
      [
        internal('import', HANDLER_REFERENCE_IDS.noFallback),
        internal('import', HANDLER_REFERENCE_IDS.fresh),
        internal('import', HANDLER_REFERENCE_IDS.path),
        internal('require', HANDLER_REFERENCE_IDS.stream),
        internal('require', HANDLER_REFERENCE_IDS.stream),
        internal('import', HANDLER_REFERENCE_IDS.escape),
        internal('require', HANDLER_REFERENCE_IDS.telemetry),
        internal('require', HANDLER_REFERENCE_IDS.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_REFERENCE_IDS.routeKind,
      '77392c6092ee7c68e5dcaae74a5f33334deb54aa2cd08f43728eeb31c7560b71',
      [
        internal('import', HANDLER_REFERENCE_IDS.noFallback),
        internal('import', HANDLER_REFERENCE_IDS.fresh),
        internal('import', HANDLER_REFERENCE_IDS.path),
        internal('require', HANDLER_REFERENCE_IDS.stream),
        internal('require', HANDLER_REFERENCE_IDS.stream),
        internal('import', HANDLER_REFERENCE_IDS.escape),
        internal('require', HANDLER_REFERENCE_IDS.telemetry),
        internal('require', HANDLER_REFERENCE_IDS.telemetryExternal),
      ],
    ),
    row(
      'noFallback',
      HANDLER_REFERENCE_IDS.noFallback,
      'd0c9bb47bd09769057828ccce13c8b5669f8437e5e10ae78bceb95648631a7bc',
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
      HANDLER_REFERENCE_IDS.fresh,
      '69ba72a2952da2213d8881bb18a78879c3d58995ecbe59a7c1dfb5c9bdeb7cc4',
      [],
    ),
    row(
      'path',
      HANDLER_REFERENCE_IDS.path,
      'c312d717beb20459ca0ca249fc054036cae236296c3d18ca34c7c8d37984bb21',
      [external('path', { kind: 'builtin', id: 'path', aliases: ['path', 'node:path'] })],
    ),
    row(
      'stream',
      HANDLER_REFERENCE_IDS.stream,
      'c8cf04f72cc181c5de0fba6cfef393a4ec2a4727f9e89f1bdb0cdc5f8512d293',
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
      HANDLER_REFERENCE_IDS.escape,
      'e62cc46b7145bbef2bc4af4b0833c588175e849bd877d702305546c970a25af5',
      [],
    ),
    row(
      'telemetry',
      HANDLER_REFERENCE_IDS.telemetry,
      '4d9ee502852ca6d8c01e500cf31a9a2d1b4e33a51b1048eb5b3a8dfd98f3711c',
      [],
    ),
    row(
      'telemetryExternal',
      HANDLER_REFERENCE_IDS.telemetryExternal,
      '3c59b282e8ec6fc0784683abd8e94ebc952015f6a2988b0b8cbf8d4502d706c1',
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
  ],
};
