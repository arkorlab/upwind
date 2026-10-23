import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { RouteEntry } from '@stayingupwind/core/manifest';

import { type CheckedStack, stampedOf } from './answers.ts';

/**
 * The shells of a build's routes, as the check reads them from the bundle's blobs, and as much of a
 * document as it reads to compare one with (`documents.ts`).
 */

/**
 * A nonce no shorter than one the edge mints, to size what is read of a document it stamps one in:
 * the shell stamped with this is as long as with any nonce up to its length, or longer.
 */
const LONGEST_NONCE_LENGTH = 64;
const LONGEST_NONCE = 'n'.repeat(LONGEST_NONCE_LENGTH);

/**
 * As much of a document as is compared with any shell of the build: the longest's length — as the
 * edge stamps its nonce in it, for a site that has it mint one (`nonces.ts`). Every route of a
 * manifest has a shell (`routeEntrySchema`): a route a build wrote none for is no route the
 * manifest holds.
 */
export async function headBytesOf(stack: CheckedStack): Promise<number> {
  let longest = 0;
  const stamped = new Set<string>();
  for (const route of Object.values(stack.manifest.routes)) {
    longest = Math.max(longest, route.shell.byteLength);
    const { sha256 } = route.shell;
    const shell =
      stack.cspNonce === undefined || stamped.has(sha256) ? undefined : shellOf(stack, route);
    stamped.add(sha256);
    if (shell !== undefined) {
      // One shell at a time, each once: a build's shells together may be more than memory holds.
      longest = Math.max(longest, (await stampedOf(stack, shell, LONGEST_NONCE)).byteLength);
    }
  }
  return longest;
}

/** The bytes the build wrote under `sha256`, as the digest names them; none if it wrote none. */
export function blobBytesOf(stack: CheckedStack, sha256: string): Buffer | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(stack.bundleDir, 'blobs', sha256));
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : undefined;
}

/** The bytes the build wrote for a route's shell, as its digest names them; none if it has none. */
export function shellOf(stack: CheckedStack, route: RouteEntry): Buffer | undefined {
  return blobBytesOf(stack, route.shell.sha256);
}
