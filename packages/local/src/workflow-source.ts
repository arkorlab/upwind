import { CLOUDFLARE_WORKFLOW_EXPORT } from '@stayingupwind/core/bundle';
import {
  formatResourcesManifest,
  RESOURCES_API_VERSION,
  RESOURCES_SYMBOL_KEY,
  type ResourceManifestEntry,
} from '@stayingupwind/core/paas';

import type { LocalModule } from './miniflare.ts';

const ENTRY = '__upwind_preview_workflow.mjs';
const RESOURCES = '__upwind_preview_resources.mjs';

/** The same serializable SDK protocol serves app RPCs and native class resource lookups. */
const INVOKE = `async function invoke(workflow, request) {
  if (request.method === 'create') return {id: (await workflow.create(request.options)).id};
  if (request.method === 'createBatch') {
    const result = await workflow.createBatch(request.options);
    return Array.isArray(result)
      ? result.map(instance => ({id: instance.id}))
      : {...result, created: result.created.map(instance => ({id: instance.id}))};
  }
  if (typeof request.id !== 'string') throw new TypeError('a Workflow instance ID is required');
  const instance = await workflow.get(request.id);
  switch (request.method) {
    case 'get': return {id: instance.id};
    case 'status': return instance.status();
    case 'pause': return instance.pause();
    case 'resume': return instance.resume();
    case 'restart': return instance.restart(request.options);
    case 'terminate': return instance.terminate(request.options);
    case 'sendEvent': return instance.sendEvent(request.options);
    case 'delete': return instance.delete();
    default: throw new TypeError('unknown Workflow operation');
  }
}`;

/** One private bridge holds only its registered native capability. */
export const WORKFLOW_BRIDGE_SOURCE = `import {WorkerEntrypoint} from 'cloudflare:workers';
${INVOKE}
export class WorkflowBridge extends WorkerEntrypoint {
  invoke(request) { return invoke(this.env.WORKFLOW, request); }
}`;

/** Publish only declared customer resources before the built customer's module graph evaluates. */
export function workflowModules(
  modules: readonly LocalModule[],
  mainModule: string,
  listed: readonly ResourceManifestEntry[],
): readonly LocalModule[] {
  if (modules.some(({ name }) => name === ENTRY || name === RESOURCES)) {
    throw new Error('a Workflow artifact uses a reserved local preview module name');
  }
  const bootstrap = `import {env} from 'cloudflare:workers';
${INVOKE}
const resources = Object.create(null);
for (const entry of ${formatResourcesManifest(listed)}) {
  if (!Object.hasOwn(env, entry.name)) continue;
  const native = env[entry.name];
  if (typeof native !== 'object' || native === null) continue;
  const binding = entry.type === 'workflow'
    ? Object.freeze({invoke: request => invoke(native, request)}) : native;
  resources[entry.name] = Object.freeze({type: entry.type, binding: binding});
}
Object.defineProperty(globalThis, Symbol.for(${JSON.stringify(RESOURCES_SYMBOL_KEY)}), {
  value: Object.freeze({version: ${String(RESOURCES_API_VERSION)}, resources: Object.freeze(resources)})
});`;
  const customerModule = JSON.stringify(`./${mainModule}`);
  return [
    {
      name: ENTRY,
      type: 'ESModule',
      // ES module dependencies evaluate in source order: publish before any customer imports.
      contents: `import './${RESOURCES}';\nexport {${CLOUDFLARE_WORKFLOW_EXPORT}} from ${customerModule};`,
    },
    { name: RESOURCES, type: 'ESModule', contents: bootstrap },
    ...modules,
  ];
}
