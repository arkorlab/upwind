import type { NextConfig } from 'next';

/**
 * Every `next.config` feature the adapter has to carry: header rules with and without a
 * condition, a redirect, an `afterFiles` rewrite ahead of the dynamic routes and one to another
 * origin, and the trailing-slash setting the sample app runs with.
 */
const nextConfig: NextConfig = {
  cacheComponents: true,
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  typescript: { tsconfigPath: './tsconfig.json' },
  headers: () => {
    return Promise.resolve([
      { source: '/(.*)', headers: [{ key: 'x-fixture', value: '1' }] },
      {
        source: '/(.*)',
        has: [{ type: 'header', key: 'x-beta' }],
        headers: [{ key: 'x-beta-feature', value: 'on' }],
      },
    ]);
  },
  redirects: () =>
    Promise.resolve([{ source: '/legacy', destination: '/static', permanent: true }]),
  rewrites: () => {
    return Promise.resolve({
      beforeFiles: [],
      afterFiles: [
        { source: '/echo-alias', destination: '/api/echo' },
        { source: '/upstream/:path*', destination: 'https://origin.fixture.test/:path*' },
      ],
      fallback: [],
    });
  },
};

export default nextConfig;
