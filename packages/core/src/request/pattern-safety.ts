import { sourceRegexSchema } from '../util/regex-source.ts';
import { IMAGE_FLAGS, SOURCE_FLAGS, unsafeSourcePatternReason } from './pattern-shape.ts';

/**
 * Whether a routing pattern is one the edge may run against a value a visitor chose.
 *
 * A hosted project's `has` / `missing` conditions carry patterns straight from its `next.config`,
 * and its routes carry the expressions Next.js compiled their sources into; the edge tests them
 * against headers, cookies, query values and pathnames on a Function shared with every other
 * project. V8's regexp engine backtracks and cannot be interrupted, so a pattern with a quantifier
 * or overlapping alternatives inside a repeated group — `(a+)+`, `(a|aa)+` — can turn a long
 * crafted value into seconds of CPU before the request has even been dispatched.
 *
 * Checked where the bundle is uploaded, never per request: a deployment that names such a pattern
 * is refused with the pattern in the message, and the edge goes on doing exactly what it did.
 *
 * The pure shape and cost check lives in `pattern-shape.ts` so request-time callers can verify
 * rewritten patterns without importing upload schemas.
 */

export { unsafeRoutePatternReason, unsafeSourcePatternReason } from './pattern-shape.ts';

/** A schema for an expression the edge runs under `flags`, refusing one it may not run. */
function runnableUnder(flags: readonly string[]): typeof sourceRegexSchema {
  return sourceRegexSchema.superRefine((source, ctx) => {
    const reason = unsafeSourcePatternReason(source, flags);
    if (reason !== undefined) {
      ctx.addIssue({ code: 'custom', message: `unusable pattern: ${reason}` });
    }
  });
}

/**
 * An expression as an upload carries it: one that compiles, and one the edge may run against a
 * pathname or a hostname a visitor chose.
 */
export const runnableSourceRegexSchema = runnableUnder(SOURCE_FLAGS);

/**
 * The same, for an image's pattern, which the optimizer runs as it is and never without regard to
 * case: judged under that reading alone, so a pattern only case tells apart — `(?:a|A)` written out
 * again and again, linear as it is run — is not refused for a reading it is never given.
 */
export const runnableImageRegexSchema = runnableUnder(IMAGE_FLAGS);
