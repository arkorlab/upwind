import type { Failure, ImportProbe } from './twoslash-probes.ts';

export type Mode = 'default' | 'esnext';

export interface AnnotationProof {
  normalStage:
    | 'preparation'
    | 'runtime-start'
    | 'request'
    | 'response-read'
    | 'annotations'
    | 'complete';
  response?: {
    status: number;
    bytes: number | null;
    stage: string | null;
    errorCategory: string | null;
    errorName: string | null;
    errorCode: string | null;
    annotationsMatch: boolean;
  };
}

export interface CaseProof extends AnnotationProof {
  status: 'pending' | 'running' | 'passed' | 'failed';
  failure?: Failure;
}

export interface LinkedModuleEvidence {
  kind: 'twoslash-entry' | 'shared-linked';
  sha256: string;
  byteLength: number;
  importMetaUrl: number;
  createRequire: number;
  createRequireFromImportMeta: number;
}

export interface Proof extends AnnotationProof {
  version: 2;
  cases: Record<Mode, CaseProof>;
  status: 'running' | 'passed' | 'failed';
  sdk: { head: string | null; baseline: string | null };
  nextVersion: string;
  packageVersions: Record<string, string | null>;
  sourceSha256: Record<string, string>;
  declarationNamedModules: number;
  tracedDeclarations: number | null;
  modulesVerified: number;
  moduleBytes: number;
  declarationBytes: number;
  nonDeclarationBytes: number;
  functionSize: { bytes: number; gzipBytes: number } | null;
  linkedModules: LinkedModuleEvidence[];
  egressAttempts: number;
  importProbe?: ImportProbe;
  linkedImportProbe?: ImportProbe;
  probeFailure?: Failure;
  linkedProbeFailure?: Failure;
  failure?: Failure;
}
