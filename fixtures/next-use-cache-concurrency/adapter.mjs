import { fileURLToPath, pathToFileURL } from 'node:url';

// The matrix supplies the workspace's built adapter, without installing a published release.
const { createAdapter } = await import(pathToFileURL(process.env.UPWIND_MATRIX_ADAPTER).href);
export default createAdapter({
  cacheHostModule: fileURLToPath(new URL('./cache-host.mjs', import.meta.url)),
});
