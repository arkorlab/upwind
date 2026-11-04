/**
 * Next.js 16.4.5 getHandler reference with server minification disabled.
 * Fixed public inputs, no SDK, no marker, two byte-identical clean offline Linux builds.
 * https://github.com/arkorlab/upwind/actions/runs/41884809602
 * Public artifact ZIP SHA-256: ee4d93ec5241c51320c2568f1cf8bb58cd735c34de32884c3b740e24dca7f543.
 * An agent wrote this data from that artifact at the owner's request, an exception to the
 * producer README. The same steps first regenerated the 16.4.4 data from that run's 16.4.4
 * artifact, byte for byte.
 * Complete original callbacks, aliases, directives and ports remain in the graph.
 * Only two independently pinned NCC __dirname literals are input-relative slots;
 * their original + '/' expressions remain in the whole-factory fingerprints.
 * Catalog selection grants no runtime or publication authority without the private
 * actual consumer, compiler-root, raw-source, SDK and final closed-graph checks.
 * Original source: https://github.com/vercel/next.js/tree/4e5335a00314be7fbb2aace5e9be56a88e64e5a8
 */
import type { NodeManifestHandlerProfile } from './node-manifest-handler-catalog.ts';
import { HANDLER_UNMINIFIED_GRAPH_16_4_5 } from './node-manifest-handler-unminified-16-4-5-graph.ts';

const profileName = 'next-16.4.5-public-pages-server-minification-off';
const nccDirectoryAssignmentOrdinal = 4;

export const NEXT_16_4_5_UNMINIFIED_HANDLER_REFERENCE: NodeManifestHandlerProfile = {
  version: 1,
  name: profileName,
  exportName: 'getHandler',
  declaredExport: 'f',
  reference: HANDLER_UNMINIFIED_GRAPH_16_4_5,
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
      key: 'next-dir:dist/compiled/@opentelemetry/api/index.js',
      row: {
        runtime: profileName,
        moduleId: 1011,
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
        nccDirectoryAssignmentOrdinal,
        'consequent',
        'expression',
        'right',
        'left',
        'expressions',
        1,
        'value',
      ],
      referenceValue:
        '/ROOT/node_modules/.pnpm/next@16.4.5_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/@opentelemetry/api',
      origin: {
        kind: 'compiler-relative-next-source-directory',
        relative: 'dist/compiled/@opentelemetry/api/index.js',
      },
    },
    {
      key: 'next-dir:dist/compiled/fresh/index.js',
      row: {
        runtime: profileName,
        moduleId: 3348,
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
        nccDirectoryAssignmentOrdinal,
        'consequent',
        'expression',
        'right',
        'left',
        'expressions',
        1,
        'value',
      ],
      referenceValue:
        '/ROOT/node_modules/.pnpm/next@16.4.5_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/fresh',
      origin: {
        kind: 'compiler-relative-next-source-directory',
        relative: 'dist/compiled/fresh/index.js',
      },
    },
  ],
};
