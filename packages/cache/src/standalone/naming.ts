import type { CacheNaming } from '@stayingupwind/host/cache';

/**
 * The label a standalone cache signs its scopes' tokens over. Whatever deploys to one signs a
 * deployment's token with it before any Function holding that token starts; a token signed under
 * another host's label is refused.
 *
 * Every standalone installation signs under this one label, and it is public: it keeps a token
 * apart from what anything else signs with the same key, not one installation from another. What
 * keeps installations apart is their keys. Each installation's `CACHE_TOKEN_KEY` is its own and is
 * never shared with another: two that shared one would each take a token the other signed, for a
 * scope of the same id.
 */
export const STANDALONE_NAMING: CacheNaming = { tokenLabel: 'upwind-cache-token' };
