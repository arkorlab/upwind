import { publishFunctionEnv } from '@stayingupwind/core/paas';

import { installFetchCacheWrites } from './fetch-cache-writes.ts';
import { nodeFunctionEnv } from './node-bindings.ts';
import { installResources } from './node-resources.ts';

// Real Node already supplies the event loop, VM, native fetch cache modes, Headers iterators,
// and cross-request AsyncLocalStorage. None of the workerd compatibility shims belong here.
const env = nodeFunctionEnv();
for (const key of ['NEXT_DEPLOYMENT_ID', 'NEXT_PRIVATE_RESPONSE_CACHE_TTL', 'ARKOR_RUNTIME']) {
  const value = env[key];
  if (typeof value === 'string') process.env[key] = value;
}
publishFunctionEnv(env);
installFetchCacheWrites();
installResources();
