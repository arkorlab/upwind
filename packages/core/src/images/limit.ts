import type { ImagesConfig } from './config.ts';

/**
 * The most a source may be, wherever it is served from: what `images.maximumResponseBody`
 * allows, within the most the Images service takes as input — one limit for the edge that
 * transforms a source and the Function that hands one out as it is, so the two never disagree on
 * what is too large.
 */

const KIB = 1024;
const MIB = KIB * KIB;
/** The most the Images service takes as input. */
const MAX_SOURCE_MIB = 20;
export const MAX_SOURCE_BYTES = MAX_SOURCE_MIB * MIB;

export function sourceSizeLimit(config: Pick<ImagesConfig, 'maximumResponseBody'>): number {
  return Math.min(config.maximumResponseBody, MAX_SOURCE_BYTES);
}
