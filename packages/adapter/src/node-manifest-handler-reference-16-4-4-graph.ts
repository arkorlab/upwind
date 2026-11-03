/** Next.js 16.4.4: fixed reference DATA from the marker-free, independently compiled public Pages fixture. */
import type {
  NodeManifestHandlerFingerprintRowData,
  NodeManifestHandlerImportData,
  NodeManifestHandlerReferenceGraphData,
  TargetData,
} from './node-manifest-handler-graph.ts';
import {
  HANDLER_REFERENCE_FACTORIES_16_4_4,
  HANDLER_REFERENCE_IDS_16_4_4,
} from './node-manifest-handler-reference-16-4-4-factories.ts';

const HANDLER_REFERENCE_RUNTIME = 'next-16.4.4-public-pages';
const streamSpecifier = 'node:stream';
const nextRoot =
  '/work/node_modules/.pnpm/next@16.4.4_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next';

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
  const whole = HANDLER_REFERENCE_FACTORIES_16_4_4[factoryName];
  if (whole?.factory.ids.includes(moduleId) !== true)
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

export const HANDLER_REFERENCE_GRAPH_16_4_4: NodeManifestHandlerReferenceGraphData = {
  root: { runtime: HANDLER_REFERENCE_RUNTIME, moduleId: HANDLER_REFERENCE_IDS_16_4_4.handler },
  nextRoot,
  rows: [
    row(
      'handler',
      HANDLER_REFERENCE_IDS_16_4_4.handler,
      'bc9ce822e11fdc156f44e26eaab52c0c5d31a1583dec61464f0854443cb90269',
      [
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.noFallback),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.fresh),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.path),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.stream),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.stream),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.escape),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.telemetry),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_REFERENCE_IDS_16_4_4.hoist,
      'b50118e7ebe01c0773b0dcede63bcb75e8b8451d029b0b879603c23b1669e6fa',
      [
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.noFallback),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.fresh),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.path),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.stream),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.stream),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.escape),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.telemetry),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.telemetryExternal),
      ],
    ),
    row(
      'handler',
      HANDLER_REFERENCE_IDS_16_4_4.routeKind,
      'f5cce7e923cce033cafbb7e6928af995dc7b0cca34514043ea14b9969a63933e',
      [
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.noFallback),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.fresh),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.path),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.stream),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.stream),
        internal('import', HANDLER_REFERENCE_IDS_16_4_4.escape),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.telemetry),
        internal('require', HANDLER_REFERENCE_IDS_16_4_4.telemetryExternal),
      ],
    ),
    row(
      'noFallback',
      HANDLER_REFERENCE_IDS_16_4_4.noFallback,
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
      HANDLER_REFERENCE_IDS_16_4_4.fresh,
      '69ba72a2952da2213d8881bb18a78879c3d58995ecbe59a7c1dfb5c9bdeb7cc4',
      [],
    ),
    row(
      'path',
      HANDLER_REFERENCE_IDS_16_4_4.path,
      'c312d717beb20459ca0ca249fc054036cae236296c3d18ca34c7c8d37984bb21',
      [external('path', { kind: 'builtin', id: 'path', aliases: ['path', 'node:path'] })],
    ),
    row(
      'stream',
      HANDLER_REFERENCE_IDS_16_4_4.stream,
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
      HANDLER_REFERENCE_IDS_16_4_4.escape,
      'e62cc46b7145bbef2bc4af4b0833c588175e849bd877d702305546c970a25af5',
      [],
    ),
    row(
      'telemetry',
      HANDLER_REFERENCE_IDS_16_4_4.telemetry,
      '4d9ee502852ca6d8c01e500cf31a9a2d1b4e33a51b1048eb5b3a8dfd98f3711c',
      [],
    ),
    row(
      'telemetryExternal',
      HANDLER_REFERENCE_IDS_16_4_4.telemetryExternal,
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
