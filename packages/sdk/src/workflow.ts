import { WORKFLOW } from './kinds.ts';
import { sole } from './sole.ts';
import { type CloudflareWorkflow, workflowBinding } from './workflow-binding.ts';

export { workflow } from './named.ts';

/** Resolve the sole published Workflow only when an operation is invoked. */
const capability: CloudflareWorkflow = workflowBinding(sole(WORKFLOW));

export default capability;

export type {
  CloudflareWorkflow,
  CloudflareWorkflowInstance,
  CloudflareWorkflowBatchResult,
} from './workflow-binding.ts';
