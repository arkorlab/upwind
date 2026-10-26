import { AuditError } from './dependencies.ts';
import type {
  NodeManifestBoundBatch,
  NodeManifestBoundStage,
} from './node-manifest-bound-batch.ts';
import { APP_PAGE_CLASS, APP_PAGE_FACTORY } from './node-manifest-framework.ts';
import { nodeManifestRegistrationProofFiles } from './node-manifest-registration-views.ts';
import type {
  NodeManifestRuntimeCallers,
  NodeManifestRuntimeCallerProof,
} from './node-manifest-runtime-callers.ts';
import type { NodeManifestRuntimeProfile } from './node-manifest-runtime-cohort.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFile,
  NodeManifestTurbopackSealedEntry,
} from './node-manifest-turbopack-graph.ts';

export function nodeManifestTurbopackProofFiles(
  graphs: readonly NodeManifestTurbopackBootGraph[],
  original: readonly NodeManifestTurbopackGraphFile[],
  callers: NodeManifestRuntimeCallerProof | undefined,
): Pick<NodeManifestTurbopackConsumerProof, 'files' | 'compilerSources'> {
  const sources = new Map<string, { readonly file: string; readonly sha256: string }>();
  for (const graph of graphs)
    sources.set(graph.runtime.file, {
      file: graph.runtime.file,
      sha256: graph.runtime.source.sha256,
    });
  return Object.freeze({
    files: Object.freeze(
      nodeManifestRegistrationProofFiles(graphs, original, callers).map((source) =>
        Object.freeze(source),
      ),
    ),
    compilerSources: Object.freeze([...sources.values()].map((source) => Object.freeze(source))),
  });
}

export interface NodeManifestTurbopackConsumerInput {
  readonly distDir: string;
  readonly rootDir: string;
  readonly assetPrefix?: string | undefined;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly entries: readonly NodeManifestTurbopackSealedEntry[];
  readonly runtimeCallers?: NodeManifestRuntimeCallers | undefined;
  readonly runtimeProfiles?: readonly NodeManifestRuntimeProfile[] | undefined;
  readonly boundBatch?: NodeManifestBoundBatch | undefined;
  readonly producer: {
    readonly id: string;
    readonly file: string;
    readonly sha256: string;
    readonly kind?:
      | 'app-page-factory'
      | 'app-page-class'
      | 'pages-class'
      | 'app-route-class'
      | 'pages-api-class';
  };
}
export interface NodeManifestTurbopackConsumerProof {
  readonly terminals: readonly (NodeManifestTurbopackSealedEntry & { readonly id: string })[];
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
  readonly compilerSources: readonly { readonly file: string; readonly sha256: string }[];
  /** Provisional only: the outer graph must commit its SDK terminal walk and close the batch. */
  readonly boundStage?: NodeManifestBoundStage | undefined;
  /** The outer graph must still visit every terminal's actual importers through the SDK root. */
  readonly requiresSdkNormalization: true;
}
export function nodeManifestTurbopackProducerKind(
  input: NodeManifestTurbopackConsumerInput,
): 'app-page' | 'pages' | 'app-route' | 'pages-api' {
  switch (input.producer.kind ?? APP_PAGE_FACTORY) {
    case APP_PAGE_FACTORY:
    case APP_PAGE_CLASS: {
      return 'app-page';
    }
    case 'pages-class': {
      return 'pages';
    }
    case 'pages-api-class': {
      return 'pages-api';
    }
    case 'app-route-class': {
      return 'app-route';
    }
    default: {
      throw new AuditError(
        'Unproved Next.js Turbopack manifest chain unknown protected producer role; refusing native publication',
      );
    }
  }
}
