import { RESOURCES_API_VERSION, RESOURCES_SYMBOL_KEY } from '@stayingupwind/core/paas';

/**
 * What a deployment published, read back.
 *
 * The publisher is not this package. A deployment's Function publishes its own storage as its
 * runtime is evaluated, and `upwind dev` and `upwind build` publish a project's local storage before
 * they run anything — in both cases at `globalThis[Symbol.for('upwind.resources')]`, under the names
 * the storage was bound to. This is the reading half, and it is the only thing here that touches
 * that symbol.
 *
 * The shapes are declared here rather than taken from `@stayingupwind/core`, deliberately. They are
 * a *reader's* view: `type` is a plain string because a newer publisher may well publish a kind of
 * storage this version has never heard of, and the honest thing to do with one is to show it rather
 * than to refuse to describe it. It also keeps this package's public declarations to itself and to
 * Cloudflare's own types, so an application needs no particular `tsconfig` to read them.
 */

/** One binding as an application finds it: what kind of storage it is, and the object for it. */
export interface PublishedResource {
  /** The kind, as the deployment listed it: `d1`, `kv_namespace`, `r2_bucket`. */
  readonly type: string;
  /** Cloudflare's own object — a `D1Database`, a `KVNamespace`, an `R2Bucket`. */
  readonly binding: unknown;
}

/** Everything published, by the name each binding was bound under; frozen, every level of it. */
export interface Published {
  /** The shape of what is published. This package reads one version and says so when it cannot. */
  readonly version: number;
  readonly resources: Readonly<Record<string, PublishedResource>>;
}

/**
 * What a look at the symbol found.
 *
 * Three answers and not two, because "nothing is published" and "something is published that this
 * cannot read" are different accidents with different fixes, and a reader that collapsed them would
 * send somebody looking for storage they have when the actual problem is a version.
 */
export type Reading =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly published: Published }
  | { readonly state: 'unreadable'; readonly saw: string };

function isResource(value: unknown): value is PublishedResource {
  return typeof value === 'object' && value !== null && 'type' in value && 'binding' in value;
}

/**
 * What was found, read as the unknown thing it is.
 *
 * Deliberately not `Partial<Published>`: nothing has checked this yet, and a type that said the
 * shape was nearly right would turn every check below into one the compiler thinks is pointless.
 */
function publishedOf(held: unknown): Reading {
  const { version, resources } = held as { version?: unknown; resources?: unknown };
  if (version !== RESOURCES_API_VERSION) {
    return { state: 'unreadable', saw: `version ${String(version)}` };
  }
  // `null` is an object, and `Object.values(null)` throws — which a reader of a global anything at
  // all may have written must not do.
  if (typeof resources !== 'object' || resources === null) {
    return { state: 'unreadable', saw: 'a version 1 with no resources' };
  }
  // Every entry, checked. What is published is frozen and built by one function, so this is not
  // expected to fail — and a reader of a global has no business assuming that.
  if (Object.values(resources).some((resource) => !isResource(resource))) {
    return { state: 'unreadable', saw: 'a version 1 with an entry of another shape' };
  }
  return {
    state: 'present',
    // The version is the one checked above, and every entry has been looked at: this is the one
    // place where what was read becomes what the rest of this package may trust.
    published: {
      version: RESOURCES_API_VERSION,
      resources: resources as Readonly<Record<string, PublishedResource>>,
    },
  };
}

/** Read the symbol. Nothing here throws: every caller decides what an answer means for it. */
export function read(): Reading {
  const held: unknown = (globalThis as Record<symbol, unknown>)[Symbol.for(RESOURCES_SYMBOL_KEY)];
  if (held === undefined || held === null) {
    return { state: 'absent' };
  }
  return typeof held === 'object'
    ? publishedOf(held)
    : { state: 'unreadable', saw: `a ${typeof held}` };
}

/**
 * Everything this deployment published, or nothing where a run published none.
 *
 * The escape hatch, and the way to see what the names actually are. It throws for storage it cannot
 * read rather than answering `undefined`: a version this package does not know is not the same fact
 * as an empty machine, and answering "nothing" to it would be a lie a caller cannot see through.
 */
export function published(): Published | undefined {
  const reading = read();
  if (reading.state === 'unreadable') {
    throw new Error(unreadable(reading.saw));
  }
  return reading.state === 'present' ? reading.published : undefined;
}

/** The one thing to say about storage published in a shape this package does not read. */
export function unreadable(saw: string): string {
  return `@stayingupwind/sdk reads version ${String(RESOURCES_API_VERSION)} of a project's published storage, and this run published ${saw}: \`upwind\` and \`@stayingupwind/sdk\` are from different releases here — install both from the same one`;
}
