import { type D1Observation, observeD1 } from './d1-observation.ts';

/**
 * A project's storage bindings on the way from its host to the application.
 *
 * A host binds each of them to the deployment's Functions under the name its owner gave it, and
 * beside them a text binding that lists them as JSON. The runtime reads that list back, picks out
 * exactly the bindings it names, and publishes them — never an environment variable, never a
 * binding of the host's — at `globalThis[Symbol.for('upwind.resources')]`, in the shape
 * `PublishedResources` describes. `version` is what lets a reader follow a change to that shape.
 */

/** The kinds of storage a binding can be, in the words Cloudflare's upload metadata uses. */
export const RESOURCE_TYPES = [
  'kv_namespace',
  'r2_bucket',
  'd1',
  'durable_object_namespace',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/**
 * The binding a deployment's Functions carry the list on, as JSON: what the runtime builds the
 * published shape from, so that what the application finds is exactly what its deployment
 * attached — never an environment variable, never a binding of the host's. Absent on a
 * deployment bound to no storage.
 */
export const RESOURCES_MANIFEST_BINDING = 'ARKOR_RESOURCES';

/**
 * The key the runtime publishes the bindings under, in the global symbol registry.
 *
 * What an application reads, so it is named for these packages and not for a host of them. Nothing
 * of this has been deployed anywhere, so no reader holds the earlier key and none is kept.
 */
export const RESOURCES_SYMBOL_KEY = 'upwind.resources';

/** The shape of what is published; raised when the shape changes in a way a reader would notice. */
export const RESOURCES_API_VERSION = 1;

/** One binding as the host lists it: its name on the Function, and its kind. */
export interface ResourceManifestEntry {
  readonly name: string;
  readonly type: ResourceType;
}

/** One binding as the application finds it: its kind, and Cloudflare's own object for it. */
export interface PublishedResource {
  readonly type: ResourceType;
  /** A `KVNamespace`, `R2Bucket`, `D1Database` or `DurableObjectNamespace`, as handed to the Function. */
  readonly binding: unknown;
}

/** What `globalThis[Symbol.for('upwind.resources')]` holds; frozen, every level of it. */
export interface PublishedResources {
  readonly version: typeof RESOURCES_API_VERSION;
  /** By binding name; an object with no prototype, so no name reads as anything inherited. */
  readonly resources: Readonly<Record<string, PublishedResource>>;
}

/** An environment a deployment's Functions are handed, as much of one as anything here reads. */
export type FunctionEnv = Readonly<Record<string, unknown>>;

const KNOWN_TYPES: ReadonlySet<string> = new Set(RESOURCE_TYPES);

export function formatResourcesManifest(entries: readonly ResourceManifestEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.type })));
}

function isEntry(value: unknown): value is ResourceManifestEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { name, type } = value as Record<string, unknown>;
  return (
    typeof name === 'string' && name !== '' && typeof type === 'string' && KNOWN_TYPES.has(type)
  );
}

/**
 * The bindings a manifest lists; nothing for one that is absent or cannot be read, and nothing of
 * an entry this runtime does not know how to publish.
 */
export function parseResourcesManifest(raw: unknown): ResourceManifestEntry[] {
  if (typeof raw !== 'string') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed
        .filter((entry) => isEntry(entry))
        .map((entry) => ({ name: entry.name, type: entry.type }))
    : [];
}

/** Resolve and deduplicate by the same name and binding checks used to publish resources. */
function resourceBindingsOf(env: FunctionEnv): Map<string, PublishedResource> {
  const resources = new Map<string, PublishedResource>();
  const listed = parseResourcesManifest(env[RESOURCES_MANIFEST_BINDING]);
  for (const entry of listed) {
    // Inherited names and listed variables never publish storage bindings.
    const binding = Object.hasOwn(env, entry.name) ? env[entry.name] : undefined;
    if (typeof binding === 'object' && binding !== null)
      resources.set(entry.name, { type: entry.type, binding });
  }
  return resources;
}

function d1BindingsIn(resources: ReadonlyMap<string, PublishedResource>): number {
  return [...resources.values()].filter((resource) => resource.type === 'd1').length;
}

/** The runtime's tag hints and observers must agree on the actually published default database. */
export function publishedD1BindingCount(env: FunctionEnv): number {
  return d1BindingsIn(resourceBindingsOf(env));
}

/**
 * The storage bindings `env` holds, as the list beside them names them; frozen throughout.
 *
 * Only what `ARKOR_RESOURCES` lists is published: an environment variable, or a binding of the
 * platform's, is never on it, whatever the application names.
 *
 * Here rather than beside the runtime that publishes it in a Function, because a Function is not
 * the only place this shape is built. `upwind dev` and `upwind build` build it in Node, from a
 * project's local storage, and the whole value of that is that they build it the same way from the
 * same list — a second implementation would be a second set of rules about what an application
 * finds. Nothing in this function is of either runtime: it reads an object and returns one.
 */
export function resourcesOf(env: FunctionEnv, observation?: D1Observation): PublishedResources {
  const resources = Object.create(null) as Record<string, PublishedResource>;
  const listed = resourceBindingsOf(env);
  const singleD1 = d1BindingsIn(listed) === 1;
  for (const [name, { type, binding }] of listed) {
    resources[name] = Object.freeze({
      type,
      binding: singleD1 && type === 'd1' ? observeD1(binding, name, observation) : binding,
    });
  }
  return Object.freeze({ version: RESOURCES_API_VERSION, resources: Object.freeze(resources) });
}
