import { createHash } from 'node:crypto';

import { manifestConstructorImport } from './node-manifest-framework.ts';
import {
  certifyNodeManifestPagesContext,
  isCertifiedNodeManifestPagesContext,
} from './node-manifest-pages-context.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumers.ts';
import type { NodeManifestTurbopackGraphFactory } from './node-manifest-turbopack-graph.ts';

/** A namespace-only leaf of the current producer proof, never a route normalization terminal. */
export function nodeManifestPagesContextLeaf(
  factory: NodeManifestTurbopackGraphFactory,
  target: string,
  unwrappedTarget: string,
  input: Pick<NodeManifestTurbopackConsumerInput, 'sources' | 'producer'>,
): boolean {
  if (input.producer.kind !== 'pages-class' || unwrappedTarget !== input.producer.id) return false;
  const edge = factory.imports[0];
  if (edge === undefined || factory.imports.length !== 1 || edge.target !== target) return false;
  const actual = input.sources.find((source) => source.id === input.producer.id);
  if (
    actual === undefined ||
    actual.file !== input.producer.file ||
    actual.source.sha256 !== input.producer.sha256 ||
    createHash('sha256').update(actual.source.code).digest('hex') !== input.producer.sha256
  )
    return false;
  const producer = manifestConstructorImport(actual.file, actual.source.sha256);
  if (producer?.kind !== 'pages') return false;
  const context = {
    projection: factory.projection,
    producer: { specifier: edge.specifier, file: actual.file, sha256: actual.source.sha256 },
  };
  const certificate = certifyNodeManifestPagesContext(context);
  return (
    certificate !== undefined &&
    certificate.root === producer.root &&
    isCertifiedNodeManifestPagesContext(certificate, context)
  );
}
