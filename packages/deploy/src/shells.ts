import type { ArtifactKind } from '@stayingupwind/core/artifact';
import {
  type DeploymentBundle,
  edgeServablePrerenders,
  prefetchSegments,
  type Prerender,
  routePagesData,
  routePayloads,
} from '@stayingupwind/core/bundle';

/**
 * What a deployment stores an artifact as: a page's own document, a prefetch segment or the whole
 * payload of one, or a Pages Router page's props.
 *
 * `static-rsc` is the kind Next.js's own name for a segment says it is — an RSC payload written at
 * build time — and `static-data` the props `next build` writes as JSON: what keeps them apart from
 * documents in the artifact record and in the metadata each is stored with.
 */
type StoredArtifactKind = Extract<ArtifactKind, 'ppr-shell' | 'static-rsc' | 'static-data'>;

/** What a page's own document is stored as: the one kind with a head to read hints from. */
export const DOCUMENT_KIND = 'ppr-shell' satisfies StoredArtifactKind;

/** One artifact to pre-compress, as the build wrote it; its length lets a compressor budget CPU. */
export interface ShellToEncode {
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  /** The route the shell was first captured from; recorded as provenance, not as a key. */
  readonly sourcePath: string;
  /**
   * Which of the two this is. A segment is an RSC payload rather than a document, so nothing reads
   * a head out of it — and its own record says what it is rather than calling it a shell.
   */
  readonly kind: StoredArtifactKind;
}

/**
 * The distinct artifacts a deployment stores for the edge: the shell of every page the edge serves
 * a document for, and the prefetch segments, whole payloads and Pages Router props of those same
 * pages.
 *
 * Each is labelled by the first pathname it was seen on and deduplicated by content, so two routes
 * that share a shell store it once. Shells are listed first, so a blob that is somehow both is
 * recorded as the document it also is.
 *
 * Only the segments of a page the edge serves (`prefetchSegments` asks the same question of a
 * segment that `edgeServablePrerenders` asks of a document, through the same options). A page left
 * to the deployment's Function keeps its prefetches with it, and storing them here would be bytes
 * moved for requests that never come.
 */
export function shellsOf(bundle: DeploymentBundle): ShellToEncode[] {
  const shells = new Map<string, ShellToEncode>();
  const add = (prerender: Prerender, kind: StoredArtifactKind): void => {
    const { body } = prerender;
    if (body === undefined || shells.has(body.sha256)) {
      return;
    }
    shells.set(body.sha256, {
      sha256: body.sha256,
      byteLength: body.byteLength,
      contentType: body.contentType,
      sourcePath: prerender.pathname,
      kind,
    });
  };
  const documents = edgeServablePrerenders(bundle, { complete: true });
  for (const prerender of documents) {
    add(prerender, DOCUMENT_KIND);
  }
  const segments = prefetchSegments(bundle, { complete: true });
  for (const segment of segments) {
    add(segment.prerender, 'static-rsc');
  }
  const payloads = routePayloads(bundle, { complete: true });
  for (const payload of payloads) {
    add(payload.prerender, 'static-rsc');
  }
  const props = routePagesData(bundle, { complete: true });
  for (const data of props) {
    add(data.prerender, 'static-data');
  }
  return [...shells.values()];
}
