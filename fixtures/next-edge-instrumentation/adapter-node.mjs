import { fileURLToPath, pathToFileURL } from 'node:url';

// The baseline keeps Node host configuration and does not opt into Edge composition.
const { createAdapter } = await import(pathToFileURL(process.env.UPWIND_MATRIX_ADAPTER).href);
export default createAdapter({
  instrumentationModules: [fileURLToPath(new URL('./host-hook.js', import.meta.url))],
});
