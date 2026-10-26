import type {
  NodeManifestHandlerLiteralSlot,
  NodeManifestHandlerReferenceGraphData,
} from './node-manifest-handler-graph.ts';
import { NEXT_16_4_3_HANDLER_REFERENCE } from './node-manifest-handler-reference.ts';

export const NODE_MANIFEST_HANDLER_MODULE = 'dist/server/route-modules/pages/pages-handler.js';
export const NODE_MANIFEST_HANDLER_SHA256 =
  'b20671fb66060f58b98fe7677adf844d10697a97b463eb2390eb00831500bda1';

export interface NodeManifestHandlerSourcePin {
  readonly relative: string;
  readonly sha256: string;
}
export interface NodeManifestHandlerProfile {
  readonly version: 1;
  readonly name: string;
  readonly exportName: 'getHandler';
  /** Independently qualified selected property in the compiled root registration. */
  readonly declaredExport: string;
  readonly reference: NodeManifestHandlerReferenceGraphData;
  /** Independently qualified, unchanged original Next sources, including the handler producer. */
  readonly sources: readonly NodeManifestHandlerSourcePin[];
  readonly literalSlots: readonly (NodeManifestHandlerLiteralSlot & {
    readonly origin: {
      readonly kind: 'compiler-relative-next-source-directory-with-trailing-slash';
      readonly relative: string;
    };
  })[];
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
/** Static, deeply frozen qualification boundary. Comparison DATA cannot populate this registry. */
export const NODE_MANIFEST_HANDLER_PROFILES: readonly NodeManifestHandlerProfile[] = immutable([
  NEXT_16_4_3_HANDLER_REFERENCE,
]);
