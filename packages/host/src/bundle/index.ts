/** The runtime cache seeded from a bundle: the build's generation of each route, as an entry. */
export { BuildTagBudget } from './build-tag-budget.ts';
export {
  buildTagsOf,
  bundleGeneratedAtMs,
  pagesDataOf,
  prerenderEntryKind,
  type SeedContext,
  type SeededRoute,
  seedRouteFor,
} from './cache-seed.ts';
