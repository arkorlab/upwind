import { fileURLToPath } from 'node:url';

export default {
  adapterPath: fileURLToPath(new URL('adapter.mjs', import.meta.url)),
  bundlePagesRouterDependencies: true,
  generateBuildId: () => 'public-pages-handler-profile-v1',
  images: { unoptimized: true },
  turbopack: { root: '/work' },
};
