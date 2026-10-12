import type { StrategyRegistry } from '@stayingupwind/host/delivery';

import { cacheApiReadthroughAssetStrategy } from './asset-cache-api-readthrough.ts';
import { passthroughAssetStrategy } from './asset-passthrough.ts';
import { r2MirrorAssetStrategy } from './asset-r2-mirror.ts';
import type { EdgeContext } from './context.ts';
import { kvShellStrategy } from './shell-kv.ts';
import { r2ShellStrategy } from './shell-r2.ts';
import { staticAssetsShellStrategy } from './shell-static-assets.ts';

/** Every backend the delivery contract names; `resolvePolicy` picks one of each per policy. */
export const edgeStrategyRegistry: StrategyRegistry<EdgeContext> = {
  shell: {
    kv: kvShellStrategy,
    r2: r2ShellStrategy,
    'static-assets': staticAssetsShellStrategy,
  },
  assets: {
    'cache-api-readthrough': cacheApiReadthroughAssetStrategy,
    passthrough: passthroughAssetStrategy,
    'r2-mirror': r2MirrorAssetStrategy,
  },
};
