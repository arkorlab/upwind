import { WORKFLOW } from './kinds.ts';
import { sole } from './sole.ts';
import { type CloudflareWorkflow, workflowBinding } from './workflow-binding.ts';

export { workflow } from './named.ts';

/** Resolve the sole published Workflow only when an operation is invoked. */
const capability: CloudflareWorkflow = workflowBinding(sole(WORKFLOW));

// eslint-disable-next-line import-x/no-default-export -- The zero-configuration SDK subpath resolves its sole capability.
export default capability;

export type {
  CloudflareWorkflow,
  CloudflareWorkflowInstance,
  CloudflareWorkflowBatchResult,
} from './workflow-binding.ts';
