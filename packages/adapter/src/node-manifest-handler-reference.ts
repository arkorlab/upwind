import type { NodeManifestHandlerProfile } from './node-manifest-handler-catalog.ts';
/**
 * Next.js 16.4.3 getHandler reference: whole factories, never an export-name shortcut.
 * The public fixture has no SDK import, marker, or custom Turbopack configuration.
 * https://github.com/arkorlab/upwind/actions/runs/40274463162
 * Two offline Linux builds from the fixed image and lock produced identical source bytes.
 * Reference artifact ZIP SHA-256: ac6aa02a6b39d2141a24e177e2d086b8bc11410cceaa6cafe580208dd80c6af3.
 * Only the two exact NCC __dirname + '/' expressions have input-relative literal slots.
 * Their original published source pins and canonical AST paths are fixed below; every
 * other statement, directive, port, alias, and effect stays in the whole-factory digest.
 * Original source: https://github.com/vercel/next.js/tree/29bbeab09981148ade186e8599ecdede15abc281
 */
import { HANDLER_REFERENCE_IDS } from './node-manifest-handler-reference-factories.ts';
import { HANDLER_REFERENCE_GRAPH } from './node-manifest-handler-reference-graph.ts';

const freshAssignmentOrdinal = 3;
const telemetryAssignmentOrdinal = 4;

export const NEXT_16_4_3_HANDLER_REFERENCE: NodeManifestHandlerProfile = {
  version: 1,
  name: 'next-16.4.3-public-pages-handler',
  exportName: 'getHandler',
  declaredExport: 'f',
  reference: HANDLER_REFERENCE_GRAPH,
  sources: [
    {
      relative: 'dist/shared/lib/no-fallback-error.external.js',
      sha256: '2e641c2ce7efe466d03751134fefec1cfd752bb00060fc7273d6d6d26e723392',
    },
    {
      relative: 'dist/compiled/@opentelemetry/api/index.js',
      sha256: '79cdf1ce026102bf94b8b9beb667d8c8635d0f702c2f118f441699684e92c2de',
    },
    {
      relative: 'dist/compiled/fresh/index.js',
      sha256: '9cf9478dc7648e4ba9a973dcd928bd4a87600edb5c02f0eaf67dd42ae845da8e',
    },
    {
      relative: 'dist/server/route-modules/pages/pages-handler.js',
      sha256: 'b20671fb66060f58b98fe7677adf844d10697a97b463eb2390eb00831500bda1',
    },
  ],
  literalSlots: [
    {
      key: 'next-dir:dist/compiled/fresh/index.js',
      row: {
        runtime: 'next-16.4.3-public-pages',
        moduleId: HANDLER_REFERENCE_IDS.fresh,
      },
      path: [
        'callback',
        'body',
        'body',
        0,
        'expression',
        'callee',
        'body',
        'body',
        freshAssignmentOrdinal,
        'expression',
        'expressions',
        0,
        'right',
        'value',
      ],
      referenceValue:
        '/ROOT/node_modules/.pnpm/next@16.4.3_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/fresh/',
      origin: {
        kind: 'compiler-relative-next-source-directory-with-trailing-slash',
        relative: 'dist/compiled/fresh/index.js',
      },
    },
    {
      key: 'next-dir:dist/compiled/@opentelemetry/api/index.js',
      row: {
        runtime: 'next-16.4.3-public-pages',
        moduleId: HANDLER_REFERENCE_IDS.telemetry,
      },
      path: [
        'callback',
        'body',
        'body',
        0,
        'expression',
        'callee',
        'body',
        'body',
        telemetryAssignmentOrdinal,
        'expression',
        'right',
        'value',
      ],
      referenceValue:
        '/ROOT/node_modules/.pnpm/next@16.4.3_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/@opentelemetry/api/',
      origin: {
        kind: 'compiler-relative-next-source-directory-with-trailing-slash',
        relative: 'dist/compiled/@opentelemetry/api/index.js',
      },
    },
  ],
};
