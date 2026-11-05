import * as z from '../schema/index.ts';
import { SNAPSHOT_PUBLICATION_VERSION } from './publication-version.ts';

const MAX_IDENTITIES = 16;
const MAX_ROUTES = 4096;

/** A deployment must be served only by readers that enforce these absolute publication bounds. */
const sources = {
  identities: z
    .array(z.string().regex(/^[a-f0-9]{64}$/u))
    .min(1)
    .max(MAX_IDENTITIES),
  routes: z.array(z.string().startsWith('/')).min(1).max(MAX_ROUTES),
  independentBuild: z.array(z.string().startsWith('/')).max(MAX_ROUTES).optional(),
};
export const publicationRequirementSchema = z.union([
  z.object({ version: z.literal(1), ...sources }),
  z.object({ version: z.literal(2), valueObservers: z.literal(true), ...sources }),
  z
    .object({
      version: z.literal(SNAPSHOT_PUBLICATION_VERSION),
      valueObservers: z.literal(true),
      resourceSnapshots: z.literal(true),
      ...sources,
    })
    .strict(),
]);
