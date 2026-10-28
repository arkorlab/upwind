/**
 * Next.js 16.4.3 getHandler reference with server minification disabled.
 * Fixed public inputs, no SDK, no marker, two byte-identical clean offline Linux builds.
 * https://github.com/arkorlab/upwind/actions/runs/40324195154
 * Public artifact ZIP SHA-256: e6ced1b48534e1805df0cb5d7e751d47239d410dde9e6c1a1eac5cb1deec6337.
 * Complete original callbacks, aliases, directives and ports remain in the graph.
 * Only two independently pinned NCC __dirname literals are input-relative slots;
 * their original + '/' expressions remain in the whole-factory fingerprints.
 * Catalog selection grants no runtime or publication authority without the private
 * actual consumer, compiler-root, raw-source, SDK and final closed-graph checks.
 */
import type { NodeManifestHandlerProfile } from './node-manifest-handler-catalog.ts';
import { HANDLER_UNMINIFIED_GRAPH } from './node-manifest-handler-unminified-graph.ts';

const profileName = 'next-16.4.3-public-pages-server-minification-off';
const nccDirectoryAssignmentOrdinal = 4;

export const NEXT_16_4_3_UNMINIFIED_HANDLER_REFERENCE: NodeManifestHandlerProfile = {
  version: 1,
  name: profileName,
  exportName: 'getHandler',
  declaredExport: 'f',
  reference: HANDLER_UNMINIFIED_GRAPH,
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
        moduleId: 5675,
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
        '/ROOT/node_modules/.pnpm/next@16.4.3_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/@opentelemetry/api',
      origin: {
        kind: 'compiler-relative-next-source-directory',
        relative: 'dist/compiled/@opentelemetry/api/index.js',
      },
    },
    {
      key: 'next-dir:dist/compiled/fresh/index.js',
      row: {
        runtime: profileName,
        moduleId: 5148,
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
        '/ROOT/node_modules/.pnpm/next@16.4.3_@types+node@24.19.2_react-dom@19.3.1_react@19.3.1__react@19.3.1/node_modules/next/dist/compiled/fresh',
      origin: {
        kind: 'compiler-relative-next-source-directory',
        relative: 'dist/compiled/fresh/index.js',
      },
    },
  ],
};
