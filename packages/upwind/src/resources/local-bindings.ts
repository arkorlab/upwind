import type { ResourceManifestEntry, ResourceType } from '@stayingupwind/core/paas';

/** The native persistence name stays fixed when a customer binding takes the visible name. */
export interface LocalStorageEntry extends ResourceManifestEntry {
  /** Only provisionable resources have a local runtime; private services are supplied separately. */
  readonly type: ResourceType;
  readonly storageName?: string;
}

const DEFAULTS: readonly LocalStorageEntry[] = [
  { name: 'UPWIND_D1', type: 'd1' },
  { name: 'UPWIND_KV', type: 'kv_namespace' },
  { name: 'UPWIND_R2', type: 'r2_bucket' },
];
const TRIAL_SECOND_D1: LocalStorageEntry = { name: 'UPWIND_D1_2', type: 'd1' };

/** Keep native customer names and SDK defaults, with the original storage identifiers. */
function localBindings(customerNames: readonly string[]): LocalStorageEntry[] {
  const occupied = new Set(customerNames);
  const defaults =
    process.env['UPWIND_TRIAL_TWO_D1'] === '1' ? [...DEFAULTS, TRIAL_SECOND_D1] : DEFAULTS;
  return defaults.map((entry) => {
    let name = entry.name;
    if (occupied.has(name)) name = `__upwind_default_${name}`;
    while (occupied.has(name)) name += '_';
    occupied.add(name);
    return { name, type: entry.type, storageName: entry.name };
  });
}

export function localEntries(
  customerNames: readonly string[],
  ai: readonly LocalStorageEntry[] = [],
  workflows: readonly string[] = [],
): LocalStorageEntry[] {
  const occupied = new Set(customerNames);
  for (const entry of ai) occupied.add(entry.name);
  const collision = workflows.find((name) => occupied.has(name));
  if (collision !== undefined)
    throw new Error(
      `Cloudflare Workflow binding ${collision} conflicts with another local resource`,
    );
  return [
    ...localBindings([...customerNames, ...ai.map((entry) => entry.name), ...workflows]),
    ...ai,
    ...workflows.map((name): LocalStorageEntry => ({ name, type: 'workflow' })),
    ...customerNames.map((name): LocalStorageEntry => {
      return {
        name,
        type: 'durable_object_namespace',
      };
    }),
  ];
}
