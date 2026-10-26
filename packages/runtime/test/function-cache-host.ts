/**
 * The runtime cache as these suites drive it: the host that serves it from behind an edge of its own
 * (`../../cache/src/function/hosted.ts`), with the artifacts' copies kept under the standalone host's
 * names and no scope beacon, so that what a suite counts of the authority is what the runtime itself
 * asked (`../../cache/src/function/host.ts` adds the beacon). Each suite hands it to the runtime as
 * `arkor:cache-host` resolves in a build.
 */
export { createBundleBlobReader, createCacheHost } from '../../cache/src/function/hosted.ts';
