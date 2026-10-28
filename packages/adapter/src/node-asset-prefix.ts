/** Exact Next29bbe next_config.rs computed_asset_prefix, from trusted adapter build config. */
export function nextClientAssetPrefix(config: {
  readonly assetPrefix?: string | undefined;
  readonly basePath?: string | undefined;
}): string {
  const prefix = config.assetPrefix ?? config.basePath ?? '';
  let end = prefix.length;
  while (end > 0 && prefix[end - 1] === '/') end -= 1;
  return `${prefix.slice(0, end)}/_next/`;
}

/** Fixed endpoint producer switches, never the runtime's own ASSET_PREFIX declaration. */
export function manifestRuntimeAssetPrefix(
  clientAssetPrefix: string | undefined,
  kind: 'app-page' | 'pages' | 'app-route' | 'pages-api',
): string | undefined {
  switch (kind) {
    case 'app-page':
    case 'pages': {
      return clientAssetPrefix;
    }
    case 'app-route':
    case 'pages-api': {
      return clientAssetPrefix === undefined ? undefined : '/';
    }
    default: {
      throw new RangeError('Unknown Next.js runtime asset profile');
    }
  }
}
