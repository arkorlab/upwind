import { withWorkflow } from 'workflow/next';

/**
 * Wrapped as the Workflow SDK's documentation has it, and nothing more: the SDK generates its flow
 * and webhook routes into `app/.well-known/workflow/v1`, which the adapter splits as it builds.
 *
 * @type {import('next').NextConfig}
 */
export default withWorkflow({});
