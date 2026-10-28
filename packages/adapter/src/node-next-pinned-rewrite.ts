import { createHash } from 'node:crypto';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import { nodeCachePolicyPatch } from './node-cache-policy.ts';
import { reviewedFrameworkSource } from './node-manifest-framework.ts';
import { LOADER, LOADER_SHA, type NodeNextRewriteInput } from './node-next-rewrite-proof.ts';
import { fetchCacheWaitUntilPatch } from './patches/fetch-cache-wait-until.ts';
import { instrumentationPatch } from './patches/instrumentation.ts';
import { resourceCacheBridgePatch } from './patches/resource-cache-bridge.ts';
import type { AppliedPatch } from './patches/rolldown.ts';

const SHARED_PATCHES = [fetchCacheWaitUntilPatch, resourceCacheBridgePatch];

function refuse(reason: string): never {
  throw new AuditError(`Unpinned Node Next.js rewrite ${reason}; refusing native publication`);
}
function digest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** A file's path inside the `next` package it belongs to, as the reviewed pins name it. */
function nextRelative(file: string): string | undefined {
  const normalized = file.split(path.sep).join('/');
  const marker = '/node_modules/next/';
  const at = normalized.lastIndexOf(marker);
  return at === -1 ? undefined : normalized.slice(at + marker.length);
}

/**
 * The rewrites of an artifact that carries the whole server output, which no proof certifies. A
 * policy target is rewritten only over its exact reviewed Next.js bytes and refused over any other;
 * the Turbopack selector is left as it is, since the bootstrap sets `TURBOPACK` itself.
 */
export function rewritePinnedNodeNextFile(
  input: NodeNextRewriteInput,
  original: { readonly file: string; readonly code: string },
  hook: boolean,
): { readonly contents: string; readonly applied: readonly AppliedPatch[] } | undefined {
  const { file, code } = original;
  const applied: AppliedPatch[] = [];
  let contents = code;
  if (instrumentationPatch.target.test(file)) {
    if (nextRelative(file) !== LOADER || digest(code) !== LOADER_SHA)
      refuse('pinned instrumentation loader');
    const result = instrumentationPatch.apply(code, file, {
      ...input.patch,
      instrumentation: hook ? '/bundle/upwind/instrumentation.cjs' : undefined,
    });
    applied.push({ patch: instrumentationPatch.name, file, result });
    contents = result.contents;
  } else if (nodeCachePolicyPatch.target.test(file)) {
    const relative = nextRelative(file);
    if (relative === undefined || reviewedFrameworkSource(relative) !== digest(code))
      refuse('pinned cache policy runtime');
    const result = nodeCachePolicyPatch.apply(code, file, input.patch);
    applied.push({ patch: nodeCachePolicyPatch.name, file, result });
    contents = result.contents;
  }
  for (const shared of SHARED_PATCHES) {
    if (shared.target.test(file) && (shared.marker === undefined || shared.marker(contents))) {
      const result = shared.apply(contents, file, input.patch);
      applied.push({ patch: shared.name, file, result });
      contents = result.contents;
    }
  }
  return contents === code ? undefined : { contents, applied };
}
