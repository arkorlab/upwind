import type { StandaloneEnv } from './env.ts';
import { handleStandalone } from './handle.ts';

/** The edge as a Worker of its own, serving one site (`handleStandalone`). */
export default {
  fetch: (request, env, ctx): Promise<Response> => handleStandalone(request, env, ctx),
} satisfies ExportedHandler<StandaloneEnv>;
