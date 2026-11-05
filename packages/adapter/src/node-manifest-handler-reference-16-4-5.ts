import type { NodeManifestHandlerProfile } from './node-manifest-handler-catalog.ts';
/**
 * Next.js 16.4.5 getHandler reference: whole factories, never an export-name shortcut.
 * The public fixture has no SDK import, marker, or custom Turbopack configuration.
 * https://github.com/arkorlab/upwind/actions/runs/41884809602
 * Two offline Linux builds from the fixed image and the 16.4.5 lock produced identical source bytes.
 * Reference artifact ZIP SHA-256: 0aa22738cc6ed4bdfb8a424e32559f379b3b48c247886e3051d74872fa1f8c82.
 * An agent wrote this data from that artifact at the owner's request, an exception to the
 * producer README. The same steps first regenerated the 16.4.4 data from that run's 16.4.4
 * artifact, byte for byte.
 * Only the two exact NCC __dirname + '/' expressions have input-relative literal slots.
 * Their original published source pins and canonical AST paths are fixed below; every
 * other statement, directive, port, alias, and effect stays in the whole-factory digest.
 * Original source: https://github.com/vercel/next.js/tree/4e5335a00314be7fbb2aace5e9be56a88e64e5a8
 */
import { HANDLER_REFERENCE_IDS_16_4_5 } from './node-manifest-handler-reference-16-4-5-factories.ts';
import { HANDLER_REFERENCE_GRAPH_16_4_5 } from './node-manifest-handler-reference-16-4-5-graph.ts';

const freshAssignmentOrdinal = 3;
const telemetryAssignmentOrdinal = 4;

export const NEXT_16_4_5_HANDLER_REFERENCE: NodeManifestHandlerProfile = {
  version: 1,
  name: 'next-16.4.5-public-pages-handler',
  exportName: 'getHandler',
  declaredExport: 'f',
  reference: HANDLER_REFERENCE_GRAPH_16_4_5,
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
        runtime: 'next-16.4.5-public-pages',
        moduleId: HANDLER_REFERENCE_IDS_16_4_5.fresh,
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
        '/ROOT/node_modules/.pnpm/next@16.4.5_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/fresh/',
      origin: {
        kind: 'compiler-relative-next-source-directory-with-trailing-slash',
        relative: 'dist/compiled/fresh/index.js',
      },
    },
    {
      key: 'next-dir:dist/compiled/@opentelemetry/api/index.js',
      row: {
        runtime: 'next-16.4.5-public-pages',
        moduleId: HANDLER_REFERENCE_IDS_16_4_5.telemetry,
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
        '/ROOT/node_modules/.pnpm/next@16.4.5_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/@opentelemetry/api/',
      origin: {
        kind: 'compiler-relative-next-source-directory-with-trailing-slash',
        relative: 'dist/compiled/@opentelemetry/api/index.js',
      },
    },
  ],
};
