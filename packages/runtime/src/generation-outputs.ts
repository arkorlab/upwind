import type { DecodedGenerationPack } from '@stayingupwind/core/cache';

import type { CacheRuntime } from './cache/runtime.ts';
import type { GenerationSource } from './generation-source.ts';
import { PAGES_DATA, ROUTE_BODY } from './representations.ts';
import type { Store } from './store.ts';

/**
 * The bytes of a generation's outputs, as `generations.ts` answers a visitor from them: the
 * record's own, the build's, or an artifact of the host's.
 */

async function readArtifact(
  runtime: CacheRuntime,
  artifactId: string,
): Promise<Uint8Array | undefined> {
  const remembered = runtime.artifactMemo.get(artifactId);
  if (remembered !== undefined) {
    return remembered;
  }
  const bytes = await runtime.host.readArtifact(artifactId);
  if (bytes !== undefined) {
    runtime.artifactMemo.set(artifactId, bytes);
  }
  return bytes;
}

/**
 * The bytes of one output of a generation: the record carries the primary one; a page's data is
 * the build's own for the build's generation, and an artifact of the host's for the rest.
 * `undefined` when the record does not lead to it.
 */
export async function outputOf(
  runtime: CacheRuntime,
  store: Store,
  pack: DecodedGenerationPack,
  source: GenerationSource,
): Promise<Uint8Array | undefined> {
  if (source.representation === 'html' || source.representation === ROUTE_BODY) {
    return pack.html;
  }
  if (pack.header.source === 'build') {
    // The build's generation names no artifacts of the host's: what the build shipped beside
    // the document is read from the bundle, and what it shipped nothing for is not there at all.
    if (source.representation !== PAGES_DATA) {
      return undefined;
    }
    const twin =
      source.dataPathname === undefined
        ? undefined
        : store.prerendersByPathname.get(source.dataPathname);
    return twin?.body === undefined ? undefined : store.readBlob(twin.body.sha256);
  }
  const ref = pack.header.artifacts.find(
    (item) => item.representationKey === source.representation,
  );
  try {
    return ref === undefined ? undefined : await readArtifact(runtime, ref.artifactId);
  } catch (error) {
    runtime.log('generation output not read', {
      pathname: source.pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
