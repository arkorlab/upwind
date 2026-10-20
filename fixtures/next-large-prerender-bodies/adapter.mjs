import { fileURLToPath, pathToFileURL } from 'node:url';

const { createAdapter } = await import(pathToFileURL(process.env.UPWIND_MATRIX_ADAPTER).href);
export default createAdapter({
  unshippedOutputs: 'prefetch-segments',
  unshippedPrerenderBodies: { minBytes: 1024 * 1024, maxBytes: 32 * 1024 * 1024 },
  cacheHostModule: fileURLToPath(new URL('./blob-host.js', import.meta.url)),
});
