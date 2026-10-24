import {
  formatResourcesManifest,
  type PublishedResources,
  RESOURCES_MANIFEST_BINDING,
  resourcesOf,
} from '@stayingupwind/core/paas';
import { describe, expect, it } from 'vitest';

import { resourcesLookup } from '../../src/resources.ts';

/**
 * The storage bindings the runtime publishes at `Symbol.for('upwind.resources')`: exactly what the
 * host listed beside them, as Cloudflare's own objects, and nothing else the Worker holds.
 */

/**
 * Stand-ins for a namespace, a bucket and a database: the runtime passes any object through
 * untouched. The fixture's Workers hold real ones (`fixture.test.ts`).
 */
const NAMESPACE = { kind: 'namespace' };
const BUCKET = { kind: 'bucket' };
const DATABASE = { kind: 'database' };

function workerEnv(
  manifest: readonly { name: string; type: 'kv_namespace' | 'r2_bucket' | 'd1' }[] | undefined,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(manifest !== undefined && {
      [RESOURCES_MANIFEST_BINDING]: formatResourcesManifest(manifest),
    }),
    CACHE: NAMESPACE,
    UPLOADS: BUCKET,
    DB: DATABASE,
    NEXT_DEPLOYMENT_ID: 'dpl_1',
    API_URL: 'https://api.test',
    ...rest,
  };
}

/** The names published, in order; the map itself has no prototype to compare against. */
function namesOf(published: PublishedResources | undefined): string[] | undefined {
  return published === undefined ? undefined : Object.keys(published.resources);
}

const ALL = [
  { name: 'CACHE', type: 'kv_namespace' },
  { name: 'DB', type: 'd1' },
  { name: 'UPLOADS', type: 'r2_bucket' },
] as const;

describe('resourcesOf', () => {
  it('publishes each listed binding by its name, with its kind, as the Worker holds it', () => {
    const published = resourcesOf(workerEnv(ALL));

    expect(published.version).toBe(1);
    expect(namesOf(published)).toStrictEqual(['CACHE', 'DB', 'UPLOADS']);
    expect(published.resources['CACHE']).toStrictEqual({
      type: 'kv_namespace',
      binding: NAMESPACE,
    });
    expect(published.resources['CACHE']?.binding).toBe(NAMESPACE);
    expect(published.resources['UPLOADS']?.binding).toBe(BUCKET);
    expect(published.resources['DB']).toStrictEqual({ type: 'd1', binding: DATABASE });
  });

  /** The application reads it; it cannot write it, for itself or for any other module. */
  it('is frozen throughout, and inherits no name', () => {
    const published = resourcesOf(workerEnv(ALL));

    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.resources)).toBe(true);
    expect(Object.isFrozen(published.resources['DB'])).toBe(true);
    expect(Object.getPrototypeOf(published.resources)).toBeNull();
    expect('toString' in published.resources).toBe(false);
  });

  /**
   * What the list does not name is not published, whatever the Worker holds: its variables, the
   * host's own bindings, and storage the host did not list.
   */
  it('publishes nothing the list does not name', () => {
    const published = resourcesOf(workerEnv([{ name: 'DB', type: 'd1' }]));

    expect(namesOf(published)).toStrictEqual(['DB']);
  });

  it('leaves out a listed name the Worker holds only text by', () => {
    const published = resourcesOf(
      workerEnv([...ALL, { name: 'API_URL', type: 'kv_namespace' }, { name: 'GONE', type: 'd1' }]),
    );

    expect(namesOf(published)).toStrictEqual(['CACHE', 'DB', 'UPLOADS']);
  });

  it.each([
    ['no list', undefined],
    ['a list that is not JSON', 'CACHE,DB'],
    ['a list that is not a list', '{"name":"CACHE","type":"kv_namespace"}'],
    ['a kind there is none of', '[{"name":"CACHE","type":"queue"}]'],
  ])('publishes nothing for %s', (_, raw) => {
    const published = resourcesOf(
      workerEnv(undefined, raw === undefined ? {} : { [RESOURCES_MANIFEST_BINDING]: raw }),
    );

    expect(published.version).toBe(1);
    expect(namesOf(published)).toStrictEqual([]);
  });
});

describe('resourcesLookup', () => {
  it('answers from the environment a request was handed, and keeps that answer', () => {
    const handed: { env: Record<string, unknown> | undefined } = { env: undefined };
    const lookup = resourcesLookup({ handed: () => handed.env, imported: undefined });

    const before = lookup();
    handed.env = workerEnv(ALL);
    const first = lookup();
    handed.env = workerEnv([]);

    // Nothing to read before the first request, when there is nothing imported to read either.
    expect(before).toBeUndefined();
    expect(namesOf(first)).toStrictEqual(['CACHE', 'DB', 'UPLOADS']);
    // An isolate's bindings do not change underneath it: the first answer stands.
    expect(lookup()).toBe(first);
  });

  /** A module's top level runs before any request: it is answered from the imported environment. */
  it('answers from the imported environment before the first request', () => {
    const imported = workerEnv(ALL);
    const handed: { env: Record<string, unknown> | undefined } = { env: undefined };
    const lookup = resourcesLookup({ handed: () => handed.env, imported });

    const early = lookup();
    handed.env = imported;

    expect(namesOf(early)).toStrictEqual(['CACHE', 'DB', 'UPLOADS']);
    // The same environment, handed: the application keeps the very object it already held.
    expect(lookup()).toBe(early);
  });

  /**
   * An imported environment that lists nothing — one a Worker is given without its bindings, say —
   * does not stand for the one requests are handed.
   */
  it('takes the environment a request was handed over an imported one', () => {
    const handed: { env: Record<string, unknown> | undefined } = { env: undefined };
    const lookup = resourcesLookup({ handed: () => handed.env, imported: {} });

    const early = lookup();
    handed.env = workerEnv(ALL);

    expect(namesOf(early)).toStrictEqual([]);
    expect(namesOf(lookup())).toStrictEqual(['CACHE', 'DB', 'UPLOADS']);
  });
});
