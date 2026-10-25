import * as z from '../schema/index.ts';
import { durableObjectDeclarationSchema } from './durable-objects.ts';

/** Host registrations, with module paths relative to the application root. */
export const cloudflareWorkflowDeclarationSchema = durableObjectDeclarationSchema.omit({
  container: true,
});
export type CloudflareWorkflowDeclaration = z.infer<typeof cloudflareWorkflowDeclarationSchema>;

export const cloudflareWorkflowDeclarationsSchema = z
  .array(cloudflareWorkflowDeclarationSchema)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.name)).size === entries.length,
    'Cloudflare Workflow binding names must be unique',
  );

/** The class the host loads, independent of the application's source export name. */
export const CLOUDFLARE_WORKFLOW_EXPORT = 'UpwindCloudflareWorkflow';
export const CLOUDFLARE_WORKFLOW_BUNDLE_VERSION = 9;
export const CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION = 10;
