import { z } from 'zod';

function compiles(source: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- compiled as Next.js compiled it, to see whether it does
    return new RegExp(source).source.length > 0;
  } catch {
    return false;
  }
}

/**
 * A pattern as Next.js compiled it, checked to compile here too: one that does not would throw
 * out of the first request that reaches it, at the edge or in the Worker, long after the build
 * or the upload that could have refused it.
 */
export const sourceRegexSchema = z
  .string()
  .min(1)
  .refine(compiles, { message: 'must be a regular expression' });
