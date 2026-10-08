import type { CacheLifeProfile, DeploymentBundle } from '@stayingupwind/core/bundle';
import type { ImagesConfig } from '@stayingupwind/core/images';

import { type BuildContext, orDefault } from './collect.ts';

/**
 * The part of `next.config` the runtime and the edge read at request time, as the bundle records
 * it (`@stayingupwind/core/bundle`, `bundleConfigSchema`): each option as Next.js resolved it, with
 * Next.js's own fallback where the build context leaves one out.
 */

/**
 * Whether prefetches carry only the static part of a route. `'unstable_eager'` is an internal
 * migration aid Next.js documented as behaving like `true`; the bundle records the behaviour, not
 * the spelling. 16.4 took it out and types the option a boolean, which is why the value is taken
 * as anything: a build of an earlier release still hands it over.
 */
function prefetchesPartially(value: unknown): boolean {
  return value === true || value === 'unstable_eager';
}

/**
 * How much of a request body Next.js buffers for the middleware, in bytes. Its config loader has
 * turned a size like `'5mb'` into a number by the time the adapter is handed the config; anything
 * else is left out, and the runtime falls back to Next.js's default.
 */
function proxyBodyLimitOf(config: BuildContext['config']): number | undefined {
  const value: unknown = orDefault<BuildContext['config']['experimental'] | undefined>(
    config.experimental,
    undefined,
  )?.proxyClientMaxBodySize;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The `cacheLife` profiles as Next.js resolved them, keeping only the three durations. */
function cacheLifeProfiles(
  profiles: BuildContext['config']['cacheLife'],
): Record<string, CacheLifeProfile> {
  const out: Record<string, CacheLifeProfile> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] = {
      ...(typeof profile.stale === 'number' && { stale: profile.stale }),
      ...(typeof profile.revalidate === 'number' && { revalidate: profile.revalidate }),
      ...(typeof profile.expire === 'number' && { expire: profile.expire }),
    };
  }
  return out;
}

/**
 * The cache handler modules an app configured, by path. The platform's Function cannot load a
 * module by path, so a build that names one is refused (`index.ts`) rather than deployed to fail
 * on its first cached request; the platform supplies the handlers itself.
 */
export function customCacheHandlerPaths(config: BuildContext['config']): string[] {
  const configured: (string | undefined)[] = [
    orDefault(config.cacheHandler, undefined),
    ...Object.values(orDefault(config.cacheHandlers, {})),
  ];
  return configured.filter((value): value is string => typeof value === 'string' && value !== '');
}

/**
 * The path Next.js serves the application's `_next` files under as well, for its `assetPrefix`:
 * `next build` rewrites `<path>/_next/:path+` to `<basePath>/_next/:path+` before the filesystem
 * is checked, the path being the prefix, or the pathname of a prefix that is a URL (`loadRewrites`,
 * in `lib/load-custom-routes.ts`). `undefined` where it writes no such rewrite: no prefix, a
 * prefix of `/`, or one that is the base path — which is what an application with a base path and
 * no prefix of its own is given.
 */
function assetPrefixPathOf(config: BuildContext['config']): string | undefined {
  const configured = orDefault(config.assetPrefix, '');
  const prefix =
    /https?:\/\//u.test(configured) && URL.canParse(configured)
      ? new URL(configured).pathname
      : configured;
  if (prefix === '' || prefix === '/') {
    return undefined;
  }
  const path = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return path === orDefault(config.basePath, '') ? undefined : path;
}

/**
 * The `htmlLimitedBots` pattern as Next.js tests it: loading the config turns the `RegExp` an app
 * writes into its source, and fills in Next.js's own list when the app names none.
 */
function htmlLimitedBotsOf(config: BuildContext['config']): string | undefined {
  const value: unknown = config.htmlLimitedBots;
  if (value instanceof RegExp) {
    return value.source;
  }
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function bundleConfig(
  config: BuildContext['config'],
  images: ImagesConfig | undefined,
): DeploymentBundle['config'] {
  const i18n = orDefault(config.i18n, null);
  const expireTime = orDefault<number | undefined>(config.expireTime, undefined);
  const cacheLife = orDefault<BuildContext['config']['cacheLife'] | undefined>(
    config.cacheLife,
    undefined,
  );
  const proxyBodyLimit = proxyBodyLimitOf(config);
  const htmlLimitedBots = htmlLimitedBotsOf(config);
  const assetPrefix = assetPrefixPathOf(config);
  return {
    ...(images !== undefined && { images }),
    basePath: orDefault(config.basePath, ''),
    ...(assetPrefix !== undefined && { assetPrefix }),
    trailingSlash: orDefault(config.trailingSlash, false),
    skipTrailingSlashRedirect: orDefault(config.skipTrailingSlashRedirect, false),
    skipProxyUrlNormalize: config.skipProxyUrlNormalize,
    ...(htmlLimitedBots !== undefined && { htmlLimitedBots }),
    poweredByHeader: orDefault(config.poweredByHeader, true),
    cacheComponents: orDefault(config.cacheComponents, false),
    partialPrefetching: prefetchesPartially(config.partialPrefetching),
    ...(expireTime !== undefined && { expireTime }),
    ...(cacheLife !== undefined && { cacheLife: cacheLifeProfiles(cacheLife) }),
    ...(proxyBodyLimit !== undefined && { proxyClientMaxBodySize: proxyBodyLimit }),
    i18n:
      i18n === null
        ? null
        : {
            defaultLocale: i18n.defaultLocale,
            locales: [...i18n.locales],
            ...(i18n.localeDetection === false && { localeDetection: false as const }),
            ...(i18n.domains !== undefined && {
              domains: i18n.domains.map((domain) => {
                return {
                  defaultLocale: domain.defaultLocale,
                  domain: domain.domain,
                  ...(domain.http === true && { http: true as const }),
                  ...(domain.locales !== undefined && { locales: [...domain.locales] }),
                };
              }),
            }),
          },
  };
}
