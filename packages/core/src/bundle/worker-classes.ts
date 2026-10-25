import {
  CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
  CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION,
} from './cloudflare-workflows.ts';
import { durableObjectBundleIssue } from './durable-objects.ts';
import type { DeploymentBundle } from './schema.ts';

/** Definitions must match their independently packaged executable Functions and version gate. */
export function workerClassIssues(bundle: DeploymentBundle): string[] {
  const objects = new Set((bundle.durableObjects ?? []).map((entry) => entry.name));
  const conflicts = (bundle.cloudflareWorkflows ?? []).filter((entry) => objects.has(entry.name));
  return [
    ...durableObjectIssues(bundle),
    ...cloudflareWorkflowIssues(bundle),
    ...conflicts.map(
      (entry) =>
        `Cloudflare Workflow binding ${entry.name} conflicts with a Durable Object binding`,
    ),
  ];
}

function durableObjectIssues(bundle: DeploymentBundle): string[] {
  const workflowVersion =
    bundle.v === CLOUDFLARE_WORKFLOW_BUNDLE_VERSION ||
    bundle.v === CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION;
  const message = durableObjectBundleIssue(bundle, workflowVersion);
  return message === undefined ? [] : [message];
}

function cloudflareWorkflowIssues(bundle: DeploymentBundle): string[] {
  const workflows = bundle.cloudflareWorkflows ?? [];
  const workflowFunctions = Object.keys(bundle.functions.cloudflareWorkflows ?? {});
  const carriesWorkflows =
    bundle.v === CLOUDFLARE_WORKFLOW_BUNDLE_VERSION ||
    bundle.v === CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION;
  if (
    (carriesWorkflows && workflows.length === 0) ||
    workflows.length !== workflowFunctions.length ||
    workflows.some(
      (entry) => !Object.hasOwn(bundle.functions.cloudflareWorkflows ?? {}, entry.name),
    ) ||
    (!carriesWorkflows &&
      (bundle.cloudflareWorkflows !== undefined ||
        bundle.functions.cloudflareWorkflows !== undefined))
  ) {
    return ['Cloudflare Workflow declarations and Functions must match, at bundle version 9 or 10'];
  }
  return [];
}
