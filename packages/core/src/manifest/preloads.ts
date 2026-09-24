import { preloadLinksSchema } from './schema.ts';

/**
 * The persisted form of a route's preloads: a JSON array in the proof's `signals` bag, or nothing
 * at all when the head named none — so a route with nothing to preload writes the row it always
 * wrote.
 */
export function serializePreloads(preloads: readonly string[]): string | undefined {
  return preloads.length === 0 ? undefined : JSON.stringify(preloads);
}

/**
 * Read back what `serializePreloads` wrote.
 *
 * Anything else is treated as nothing recorded. A signal this cannot read must not take the route
 * out of the manifest: the shell was proved regardless, and a document served without the hint is
 * the document this route had before the field existed.
 */
export function parsePreloads(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  try {
    const parsed = preloadLinksSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
