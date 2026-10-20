import {
  cacheablePrerenders,
  type DeploymentBundle,
  type Prerender,
  staticPagesMembersOf,
} from '@stayingupwind/core/bundle';
import { KEY_SCHEMA_VERSION } from '@stayingupwind/core/cache';
import { bundleGeneratedAtMs, type SeedContext, seedRouteFor } from '@stayingupwind/host/bundle';
import type { CacheEnvironment, SeedEntryInput, SeedScopeInput } from '@stayingupwind/host/cache';

/**
 * What a deployment's runtime cache is seeded with from its build: the scope, which is the
 * deployment and shared with no other, and the build's generation of every document the edge may
 * serve.
 */

export interface ScopeOfDeployment {
  readonly deploymentId: string;
  readonly projectId: string;
  readonly environment: CacheEnvironment;
  readonly buildId: string;
  /** Whose the deployment is, as the host names its owners. */
  readonly owner: string;
}

/** The scope a deployment's cache is seeded under: the deployment is the scope. */
export function seedScopeOf(input: ScopeOfDeployment): SeedScopeInput['scope'] {
  return {
    scopeId: input.deploymentId,
    organizationId: input.owner,
    projectId: input.projectId,
    environmentId: input.environment,
    deploymentId: input.deploymentId,
    keySchemaVersion: KEY_SCHEMA_VERSION,
    buildId: input.buildId,
  };
}

/** The prerenders the cache holds a generation of, by id, in the bundle's order. */
export function cacheEntryIdsOf(bundle: DeploymentBundle): string[] {
  return cachePrerendersOf(bundle).map((prerender) => prerender.id);
}

/** Version three independently admits concrete parameter outputs, never a class generation. */
export function cachePrerendersOf(bundle: DeploymentBundle): Prerender[] {
  const prerenders = new Set(cacheablePrerenders(bundle));
  for (const page of staticPagesMembersOf(bundle).keys()) prerenders.add(page);
  return [...prerenders];
}

/**
 * When the build ran, by the clock of the machine it ran on — and never later than `now`. A bundle
 * stamped ahead, built where the clock ran fast, would have every lifetime measured from a moment
 * yet to come: a page that revalidates each minute would stay fresh until that clock came round,
 * and a year ahead, ISR would not run for a year. Held to the seeding rather than refused, since a
 * skewed clock is no reason to turn a deployment away, and the seeding is when the generation goes
 * into the cache.
 */
export function seededGenerationAt(bundle: DeploymentBundle, now: number): number {
  return Math.min(bundleGeneratedAtMs(bundle), now);
}

/** The prerenders the cache holds a generation of, by id: what each batch of a seeding is read from. */
export function cacheEntriesOf(bundle: DeploymentBundle): ReadonlyMap<string, Prerender> {
  return new Map(cachePrerendersOf(bundle).map((prerender) => [prerender.id, prerender]));
}

/**
 * One batch of the build's generations: what the bundle says of each prerender named, as an entry.
 * A seeding of many batches in one process hands each of them the one index it made
 * (`cacheEntriesOf`), rather than have every batch classify the whole bundle again.
 */
export async function seedEntriesOf(
  bundle: DeploymentBundle,
  prerenderIds: readonly string[],
  context: SeedContext,
  byId: ReadonlyMap<string, Prerender> = cacheEntriesOf(bundle),
): Promise<SeedEntryInput[]> {
  const entries: SeedEntryInput[] = [];
  for (const id of prerenderIds) {
    const prerender = byId.get(id);
    if (prerender === undefined) {
      throw new Error(`prerender ${id} is not one the cache holds`);
    }
    const seeded = await seedRouteFor(bundle, prerender, context);
    if (seeded !== undefined) {
      entries.push(seeded.input);
    }
  }
  return entries;
}
