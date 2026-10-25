import type { CommitRequest as AuthorityCommitRequest } from '@stayingupwind/host/cache';
import type { CommitRequest } from '@stayingupwind/runtime/cache-host';

import { unixMilliseconds } from './timestamp.ts';

/** Native artifacts retain their bytes; the runtime's writes cover all their dependencies. */
export function authorityCommitRequest(request: CommitRequest): AuthorityCommitRequest {
  const generation = request.generation;
  return {
    fencingToken: request.fencingToken,
    observedTagRevision: request.observedTagRevision,
    heldTagRevisions: request.heldTagRevisions,
    generation: {
      ...generation,
      cacheTimestamp: unixMilliseconds(generation.cacheTimestamp),
      producedAt: unixMilliseconds(generation.producedAt),
      tags: [...generation.tags],
      outputs: generation.outputs.map((output) => {
        return {
          ...output,
          artifacts: output.artifacts.map((artifact) => {
            return {
              ...artifact,
              encoding: 'identity' as const,
            };
          }),
        };
      }),
      dependencyCoverage: 'complete',
      dependencies: [],
      producer: { kind: 'attempt', reason: generation.reason },
    },
  };
}
