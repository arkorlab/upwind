import type {
  ArtifactLocator,
  ArtifactRef,
  ShellEncoding,
  ShellEncodings,
} from '@stayingupwind/core/artifact';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import type { DeliveryPolicy } from '@stayingupwind/host/delivery';

/**
 * What delivering a manifest asks of storage: the shells and segments it names, each placed once,
 * under a policy whose backends the edge reads from.
 */

/**
 * One shell to place, keyed by hash rather than by route: placement is content-addressed, so routes
 * that share a shell share a single placement instead of moving the same bytes once each.
 */
export interface ShellPlacement {
  readonly sha256: string;
  readonly contentType: string;
  readonly byteLength: number;
  /** The route the shell was first captured from; recorded as provenance, not as a key. */
  readonly sourcePath: string;
  /** The shell's pre-compressed renderings, placed alongside it under their own hashes. */
  readonly renderings: readonly ShellRendering[];
}

interface ShellRendering extends ArtifactLocator {
  readonly encoding: ShellEncoding;
}

const IMPLEMENTED_SHELL_BACKENDS: ReadonlySet<string> = new Set(['kv', 'r2']);
const IMPLEMENTED_ASSET_BACKENDS: ReadonlySet<string> = new Set([
  'cache-api-readthrough',
  'passthrough',
  'r2-mirror',
  'workers-cache',
]);

/** The backend a policy names that the edge does not read from, or `undefined` for none. */
export function unimplementedBackend(policy: DeliveryPolicy): string | undefined {
  if (!IMPLEMENTED_SHELL_BACKENDS.has(policy.shell.backend)) {
    return policy.shell.backend;
  }
  if (!IMPLEMENTED_ASSET_BACKENDS.has(policy.assets.backend)) {
    return policy.assets.backend;
  }
  return undefined;
}

/** The distinct shells a manifest needs placed, in the order its routes name them. */
export function shellPlacementsOf(manifest: ProjectManifest): ShellPlacement[] {
  const shells = new Map<string, ShellPlacement>();
  // Everything the manifest names has to be in place before it is published, whether a request
  // arrives for a page's document, for one of the prefetch segments beside it or for its whole
  // payload: a manifest naming bytes nobody placed is a route the edge promises and cannot keep.
  const place = (
    artifact: ArtifactRef,
    encodings: ShellEncodings | undefined,
    sourcePath: string,
  ): void => {
    if (shells.has(artifact.sha256)) {
      return;
    }
    const renderings = [encodings?.br, encodings?.gzip];
    shells.set(artifact.sha256, {
      sha256: artifact.sha256,
      contentType: artifact.contentType,
      byteLength: artifact.byteLength,
      sourcePath,
      renderings: renderings.filter((rendering) => rendering !== undefined),
    });
  };
  const routes = Object.values(manifest.routes);
  for (const entry of routes) {
    place(entry.shell, entry.shellEncodings, entry.pathname);
    if (entry.payload !== undefined) {
      place(entry.payload.artifact, entry.payload.encodings, `${entry.pathname}.rsc`);
    }
    if (entry.pagesData !== undefined) {
      place(entry.pagesData.artifact, entry.pagesData.encodings, `${entry.pathname}.json`);
    }
    if (entry.segments === undefined) {
      continue;
    }
    const segments = Object.entries(entry.segments);
    for (const [segmentPath, segment] of segments) {
      place(segment.artifact, segment.encodings, `${entry.pathname}${segmentPath}`);
    }
  }
  return [...shells.values()];
}
