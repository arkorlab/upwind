import * as z from '@stayingupwind/core/schema';

/**
 * Where a manifest's artifacts were placed, by backend, and when each copy was last verified there.
 *
 * Apart from the delivery policy (`policy.ts`), which the edge reads on every request: a schema is
 * built when its module is evaluated, so these were built, and carried, by every reader of the
 * policy, which reads none of them. The edge finds an artifact by its hash on each backend
 * (`kvArtifactKey`, `r2ArtifactKey`) and never looks a placement up.
 */

export const placementBackendSchema = z.enum([
  'kv',
  'r2',
  'cache-api',
  'static-assets',
  'worker-bundle',
]);
export type PlacementBackend = z.infer<typeof placementBackendSchema>;

export const placementSchema = z.object({
  backend: placementBackendSchema,
  locator: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  verifiedAt: z.iso.datetime(),
});
export type Placement = z.infer<typeof placementSchema>;

export const placementMapSchema = z.object({
  manifestId: z.string().min(1),
  placements: z.record(z.string(), z.array(placementSchema)),
});
export type PlacementMap = z.infer<typeof placementMapSchema>;
