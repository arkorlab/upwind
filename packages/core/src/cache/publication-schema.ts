import * as z from '../schema/index.ts';

const MAX_IDENTITIES = 16;
const MAX_ROUTES = 4096;

/** A deployment must be served only by readers that enforce these absolute publication bounds. */
export const publicationRequirementSchema = z.object({
  version: z.literal(1),
  identities: z
    .array(z.string().regex(/^[a-f0-9]{64}$/u))
    .min(1)
    .max(MAX_IDENTITIES),
  routes: z.array(z.string().startsWith('/')).min(1).max(MAX_ROUTES),
  independentBuild: z.array(z.string().startsWith('/')).max(MAX_ROUTES).optional(),
});
