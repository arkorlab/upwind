import { type Patch, Rewrite } from './types.ts';

/**
 * Next.js caps resume-cache inflation at five times the configured postponed-state limit,
 * 500 MiB by default. workerd's zlib API rejects maxOutputLength above 128 MiB before reading
 * any bytes, so even a tiny resume cache is discarded. Bound Next.js's limit by the API's
 * maximum, preserving smaller user limits and the protection against decompression bombs.
 */
const NAME = 'resume-cache-limit';
// eslint-disable-next-line require-unicode-regexp -- a bundler filter: a Go regular expression
const TARGET = /next-server\/app-page(?:-turbo)?(?:-experimental)?\.runtime\.prod\.js$/;
const NEXT_LIMIT = /\b\w+\?5\*\w+:524288e3/gu;
const WORKER_MAX_OUTPUT_BYTES = 134_217_728;

export const resumeCacheLimitPatch: Patch = {
  name: NAME,
  target: TARGET,
  nextVersions: ['16.3.5', '16.3.6'],
  apply(source, file) {
    const result = new Rewrite(NAME, file, source).replace(
      NEXT_LIMIT,
      (match) => `Math.min(${match},${WORKER_MAX_OUTPUT_BYTES})`,
      1,
      'the resume cache decompression limit',
    );
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};
