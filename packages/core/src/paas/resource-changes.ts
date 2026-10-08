import type { RouteEntryDescriptor } from '../cache/index.ts';

/** The narrow, deployment-bound resource-change receiver supplied by a host. */
export const RESOURCE_CHANGES_SERVICE_BINDING = 'ARKOR_RESOURCE_CHANGES';
export const RESOURCE_CHANGES_ENTRYPOINT = 'ResourceChangesEntrypoint';

/** Identity written into service-binding metadata, never supplied by application code. */
export interface ResourceChangesProps {
  readonly v: 1;
  readonly projectId: string;
  readonly deploymentId: string;
}

export interface ResourceChangeReport {
  readonly eventId: string;
  readonly type: 'd1';
  readonly bindingName: string;
}

/** A durable receipt; propagation and regeneration continue after this answer. */
export interface ResourceChangeAcknowledgement {
  readonly v: 1;
  readonly kind: 'accepted';
  readonly revision: number;
}

export interface ResourceChangesReceiver {
  reportResourceChange(report: ResourceChangeReport): Promise<ResourceChangeAcknowledgement>;
}

/** Trusted identity resolved by an ingress adapter before the common processor is called. */
export interface ResourceChanged {
  readonly projectId: string;
  readonly bindingId: string;
  readonly type: 'd1';
  readonly eventId: string;
}

/** Available only through the host's dispatch binding props, never through HTTP headers. */
export interface ResourceWarmProps {
  readonly resourceWarm: {
    readonly v: 1;
    readonly scopeId: string;
    readonly entry: RouteEntryDescriptor;
  };
}

export type ResourceWarmResult =
  | { readonly v: 1; readonly kind: 'published'; readonly generationId: string }
  | { readonly v: 1; readonly kind: 'busy' | 'skipped' | 'unsupported' }
  | { readonly v: 1; readonly kind: 'failed'; readonly error: string };
