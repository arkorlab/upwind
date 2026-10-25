/* eslint-disable unicorn/no-keyword-prefix -- Native Workflow registration uses className. */
import {
  CLOUDFLARE_WORKFLOW_EXPORT,
  type DeploymentBundle,
  type FunctionSpec,
} from '@stayingupwind/core/bundle';
import {
  formatResourcesManifest,
  parseResourcesManifest,
  RESOURCES_MANIFEST_BINDING,
} from '@stayingupwind/core/paas';
import type { ServiceBinding } from '@stayingupwind/deploy/bindings';

import type { FunctionBindings } from './functions.ts';
import type { LocalWorker } from './miniflare.ts';
import { WORKFLOW_BRIDGE_SOURCE, workflowModules } from './workflow-source.ts';

type WorkflowBundle = Pick<DeploymentBundle, 'deploymentId' | 'cloudflareWorkflows' | 'functions'>;
type MakeWorker = (
  blobs: string,
  name: string,
  spec: FunctionSpec,
  bindings: FunctionBindings,
) => LocalWorker;

interface WorkflowWorkers {
  readonly workers: readonly LocalWorker[];
  readonly bindings: FunctionBindings;
}

/** Verified built classes share the stack's customer stores, with no platform service authority. */
export function cloudflareWorkflowWorkers(
  blobs: string,
  bundle: WorkflowBundle,
  bindings: FunctionBindings,
  makeWorker: MakeWorker,
): WorkflowWorkers | undefined {
  const definitions = bundle.cloudflareWorkflows ?? [];
  const artifacts = bundle.functions.cloudflareWorkflows ?? {};
  const names = new Set(definitions.map(({ name }) => name));
  if (names.size === 0 && Object.keys(artifacts).length === 0) return undefined;
  if (
    names.size !== definitions.length ||
    names.size !== Object.keys(artifacts).length ||
    Object.keys(artifacts).some((name) => !names.has(name))
  ) {
    throw new Error(
      `${bundle.deploymentId}'s Cloudflare Workflow registrations and artifacts differ`,
    );
  }
  const listed = parseResourcesManifest(
    bindings.text.findLast(({ name }) => name === RESOURCES_MANIFEST_BINDING)?.value,
  );
  const occupied = new Set([
    ...bindings.text
      .filter(({ name }) => name !== RESOURCES_MANIFEST_BINDING)
      .map(({ name }) => name),
    ...bindings.services.map(({ name }) => name),
    ...listed.map(({ name }) => name),
    ...Object.keys(bindings.stores?.kvNamespaces ?? {}),
    ...Object.keys(bindings.stores?.r2Buckets ?? {}),
    ...Object.keys(bindings.stores?.d1Databases ?? {}),
    RESOURCES_MANIFEST_BINDING,
  ]);
  const services: ServiceBinding[] = [];
  const native = Object.fromEntries(
    definitions.map(({ name }) => {
      return [
        name,
        {
          name: `upwind-workflow-${name}`,
          className: CLOUDFLARE_WORKFLOW_EXPORT,
          scriptName: `upwind-workflow-${name}`,
        },
      ];
    }),
  );
  listed.push(...definitions.map(({ name }) => ({ name, type: 'workflow' as const })));
  const workers = definitions.flatMap(({ name }) => {
    if (occupied.has(name))
      throw new Error(`${name} cannot be bound to a Workflow: the name is already taken`);
    const spec = artifacts[name];
    if (spec === undefined) throw new Error(`${name}'s Cloudflare Workflow artifact is missing`);
    const workerName = `upwind-workflow-${name}`;
    const bridgeName = `upwind-workflow-bridge-${name}`;
    const workflow = {
      name: workerName,
      className: CLOUDFLARE_WORKFLOW_EXPORT,
      scriptName: workerName,
    };
    services.push({ name, service: bridgeName, entrypoint: 'WorkflowBridge' });
    const customer = makeWorker(blobs, workerName, spec, {
      text: bindings.workflowText ?? [],
      services: [],
      stores: bindings.stores,
    });
    return [
      {
        ...customer,
        modules: workflowModules(customer.modules, spec.mainModule, listed),
        workflows: native,
      },
      {
        name: bridgeName,
        compatibilityDate: spec.compatibilityDate,
        modules: [
          { type: 'ESModule' as const, name: 'bridge.mjs', contents: WORKFLOW_BRIDGE_SOURCE },
        ],
        workflows: { WORKFLOW: workflow },
      },
    ];
  });
  return {
    workers,
    bindings: {
      ...bindings,
      services: [...bindings.services, ...services],
      text: [
        ...bindings.text.filter(({ name }) => name !== RESOURCES_MANIFEST_BINDING),
        { name: RESOURCES_MANIFEST_BINDING, value: formatResourcesManifest(listed), secret: false },
      ],
    },
  };
}
