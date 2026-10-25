import type { Plugin } from 'rolldown';

import { rekeyManifestsGraph } from '../patches/graph-manifests.ts';

const EDGE_MANIFESTS_KEY = 'arkor.next.server.manifests.edge';

/**
 * Native Node and bundled Edge entries have different work stores in the same realm. Keep
 * Edge's manifest proxy beside its own store; the unbundled Node graph keeps Next.js's key.
 * This is graph ownership, independent of Workers compatibility patches.
 */
export function nativeEdgeGraphPlugin(): Plugin {
  return {
    name: 'upwind-native-edge-manifests',
    transform(source, file) {
      if (!source.includes('next.server.manifests')) return null;
      const contents = rekeyManifestsGraph(source, file, EDGE_MANIFESTS_KEY);
      return contents === source ? null : { code: contents, map: null };
    },
  };
}
