import type {
  WorkflowInstance,
  WorkflowInstanceCreateOptions,
  WorkflowBatchCreateOptions,
  WorkflowBatchCreateResult,
} from '@cloudflare/workers-types';

/** Native-shaped methods supported by a scoped hosted Workflow capability. */
export type CloudflareWorkflowInstance = Pick<
  WorkflowInstance,
  'id' | 'status' | 'pause' | 'resume' | 'restart' | 'terminate' | 'sendEvent' | 'delete'
>;
export type CloudflareWorkflowBatchResult = Omit<WorkflowBatchCreateResult, 'created'> & {
  readonly created: CloudflareWorkflowInstance[];
};
export interface CloudflareWorkflow<Params = unknown> {
  create(options?: WorkflowInstanceCreateOptions<Params>): Promise<CloudflareWorkflowInstance>;
  get(id: string): Promise<CloudflareWorkflowInstance>;
  createBatch(options: WorkflowBatchCreateOptions<Params>): Promise<CloudflareWorkflowBatchResult>;
  createBatch(
    options: WorkflowInstanceCreateOptions<Params>[],
  ): Promise<CloudflareWorkflowInstance[]>;
}

/** A host grants scope in the binding itself; callers supply no tenant or deployment identity. */
export interface CloudflareWorkflowRequest {
  readonly method:
    | 'create'
    | 'createBatch'
    | 'get'
    | 'status'
    | 'pause'
    | 'resume'
    | 'restart'
    | 'terminate'
    | 'sendEvent'
    | 'delete';
  readonly id?: string;
  readonly options?: unknown;
}

export interface CloudflareWorkflowBridge {
  invoke(request: CloudflareWorkflowRequest): Promise<unknown>;
}

function instance(bridge: CloudflareWorkflowBridge, value: unknown): CloudflareWorkflowInstance {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string'
  ) {
    throw new TypeError('the Workflow bridge returned an invalid instance handle');
  }
  const id = value.id;
  const call = (method: CloudflareWorkflowRequest['method'], options?: unknown) =>
    bridge.invoke({ method, id, ...(options === undefined ? {} : { options }) });
  return Object.freeze({
    id,
    status: () => call('status'),
    pause: () => call('pause'),
    resume: () => call('resume'),
    restart: (options?: unknown) => call('restart', options),
    terminate: (options?: unknown) => call('terminate', options),
    sendEvent: (options: unknown) => call('sendEvent', options),
    delete: () => call('delete'),
  }) as unknown as CloudflareWorkflowInstance;
}

/** Keep native instance IDs synchronous without transferring a provider handle across RPC. */
export function workflowBinding<Params = unknown>(binding: unknown): CloudflareWorkflow<Params> {
  if (typeof binding !== 'object' || binding === null) {
    throw new TypeError('the published Workflow binding is not a capability');
  }
  const bridge = binding as CloudflareWorkflowBridge;
  return Object.freeze({
    async create(options?: unknown) {
      return instance(
        bridge,
        await bridge.invoke({ method: 'create', ...(options === undefined ? {} : { options }) }),
      );
    },
    async get(id: string) {
      return instance(bridge, await bridge.invoke({ method: 'get', id }));
    },
    async createBatch(options: unknown) {
      const result = await bridge.invoke({ method: 'createBatch', options });
      if (Array.isArray(result)) return result.map((value: unknown) => instance(bridge, value));
      if (
        typeof result === 'object' &&
        result !== null &&
        'created' in result &&
        Array.isArray(result.created)
      ) {
        return {
          ...result,
          created: result.created.map((value: unknown) => instance(bridge, value)),
        };
      }
      throw new TypeError('the Workflow bridge returned an invalid batch');
    },
  }) as unknown as CloudflareWorkflow<Params>;
}
