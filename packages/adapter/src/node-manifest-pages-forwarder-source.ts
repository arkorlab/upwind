import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Node } from './lexical-scope.ts';
import { manifestConstructorImport } from './node-manifest-framework.ts';
import { nodeManifestRegistrationForwarderData } from './node-manifest-registration-forwarders.ts';
import type { NodeManifestTurbopackGraphFile } from './node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';

export interface NodeManifestPagesForwarderSource {
  readonly kind: 'pending Pages producer source';
  readonly sourceId: string;
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly nextRoot: string;
  readonly canonicalModule: string;
  readonly actualRelative: string;
  readonly exporter: 'commonjs' | 'n' | 'v';
  readonly externalSpecifier: string;
}

/** Exact published source plus finite raw forwarding DATA; never a completed class proof. */
export function nodeManifestPagesForwarderSource(
  factory: Node,
  projection: NodeManifestTurbopackProjection,
  target: NodeManifestTurbopackGraphFile,
): NodeManifestPagesForwarderSource | undefined {
  const data = nodeManifestRegistrationForwarderData(factory, projection);
  if (
    data === undefined ||
    data.interop ||
    data.imported.kind !== 'external' ||
    data.imported.targetId !== undefined ||
    !path.isAbsolute(target.file) ||
    path.resolve(target.file) !== target.file ||
    createHash('sha256').update(target.source.code).digest('hex') !== target.source.sha256
  )
    return undefined;
  const identity = manifestConstructorImport(target.file, target.source.sha256);
  if (identity?.kind !== 'pages') return undefined;
  return Object.freeze<NodeManifestPagesForwarderSource>({
    kind: 'pending Pages producer source',
    sourceId: target.id,
    sourceFile: target.file,
    sourceSha256: target.source.sha256,
    nextRoot: identity.root,
    canonicalModule: identity.module,
    actualRelative: identity.relative,
    exporter: data.exporter,
    externalSpecifier: data.imported.specifier,
  });
}
