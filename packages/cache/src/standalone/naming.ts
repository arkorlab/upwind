import type { CacheNaming } from '@stayingupwind/host/cache';

/**
 * The label a standalone cache signs its scopes' tokens over. Whatever deploys to one signs a
 * deployment's token with it before any Function holding that token starts; a token signed under
 * another install's label is refused.
 */
export const STANDALONE_NAMING: CacheNaming = { tokenLabel: 'upwind-cache-token' };
