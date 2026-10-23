import type { AssetDeliveryStrategy } from '@stayingupwind/host/delivery';

import { readThrough } from './asset-cache-api-readthrough.ts';
import type { EdgeContext } from './context.ts';

const STRATEGY_ID = 'r2-mirror';

/**
 * The default asset backend.
 *
 * Every file the build shipped is in the manifest and served from storage before a request gets
 * this far (`static-file`). What reaches this strategy is an asset the manifest does not name, and
 * the only party that can say what it is is the deployment's own Worker: a read-through of it.
 */
export const r2MirrorAssetStrategy: AssetDeliveryStrategy<EdgeContext, typeof STRATEGY_ID> = {
  id: STRATEGY_ID,
  handle: (request, originUrl, ctx) => readThrough(request, originUrl, ctx, STRATEGY_ID),
};
