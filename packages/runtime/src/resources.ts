import {
  parseResourcesManifest,
  type PublishedResource,
  type PublishedResources,
  publishedFunctionEnv,
  RESOURCES_API_VERSION,
  RESOURCES_MANIFEST_BINDING,
  RESOURCES_SYMBOL_KEY,
} from '@stayingupwind/core/paas';
import { env as importedEnv } from 'cloudflare:workers';

/**
 * A deployment's storage bindings, published at `globalThis[Symbol.for('upwind.resources')]` for
 * the application to read: its KV namespaces, R2 buckets and D1 databases, by the names their
 * owner gave them, as Cloudflare's own objects.
 *
 * The symbol is defined once per isolate, as the runtime is evaluated and before any of the
 * application is; nothing here runs on a request. What it holds is worked out at the first look
 * at it, from the environment the Function's requests are handed (`publishFunctionEnv`, at the top of
 * every `fetch`), and kept from then on, since an isolate's bindings do not change underneath it.
 * A look before the first request — from a module's top level — is answered from the environment
 * the runtime imports, which in a Function that has one is the same environment; I/O through what it
 * holds still has to wait for a request, as it does for any binding.
 *
 * Only what `ARKOR_RESOURCES` lists is published: an environment variable, or a binding of the
 * platform's, is never on it, whatever the application names.
 */

type FunctionEnv = Readonly<Record<string, unknown>>;

/** The storage bindings `env` holds, as the list beside them names them; frozen throughout. */
export function resourcesOf(env: FunctionEnv): PublishedResources {
  const resources = Object.create(null) as Record<string, PublishedResource>;
  const listed = parseResourcesManifest(env[RESOURCES_MANIFEST_BINDING]);
  for (const entry of listed) {
    const binding = env[entry.name];
    // A name the Function holds no object by is left out: the application finds nothing there,
    // rather than text where it expects storage.
    if (typeof binding === 'object' && binding !== null) {
      resources[entry.name] = Object.freeze({ type: entry.type, binding });
    }
  }
  return Object.freeze({ version: RESOURCES_API_VERSION, resources: Object.freeze(resources) });
}

/** Where the bindings are read from: the environment a request was handed, and the imported one. */
export interface ResourceSources {
  /** The environment the last request was handed; `undefined` before the first. */
  readonly handed: () => FunctionEnv | undefined;
  /** The environment the runtime imported; `undefined` where there is none. */
  readonly imported: FunctionEnv | undefined;
}

/**
 * What a look at the symbol answers. Settled for good by the first look once a request has been
 * handed its environment; before that, what the imported environment holds, or `undefined` when
 * there is nothing to read yet.
 */
export function resourcesLookup(sources: ResourceSources): () => PublishedResources | undefined {
  let settled: PublishedResources | undefined;
  let early: PublishedResources | undefined;
  return () => {
    if (settled !== undefined) {
      return settled;
    }
    const handed = sources.handed();
    if (handed !== undefined) {
      // The same environment as the one imported, as it is in a Function that has both: the
      // application keeps the very object it may already hold.
      settled = early !== undefined && handed === sources.imported ? early : resourcesOf(handed);
      return settled;
    }
    if (sources.imported !== undefined) {
      early ??= resourcesOf(sources.imported);
    }
    return early;
  };
}

function importable(env: unknown): FunctionEnv | undefined {
  return typeof env === 'object' && env !== null ? (env as FunctionEnv) : undefined;
}

/** Define the symbol, once: the application can read it, and neither replace nor remove it. */
export function installResources(): void {
  const key = Symbol.for(RESOURCES_SYMBOL_KEY);
  if (Object.hasOwn(globalThis, key)) {
    return;
  }
  Object.defineProperty(globalThis, key, {
    configurable: false,
    enumerable: false,
    get: resourcesLookup({ handed: publishedFunctionEnv, imported: importable(importedEnv) }),
  });
}
