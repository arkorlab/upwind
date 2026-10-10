import type { DurableObjectNamespace } from '@cloudflare/workers-types';

import { DURABLE_OBJECT } from './kinds.ts';
import { sole } from './sole.ts';

export { durableObject } from './named.ts';

/** The one published native namespace, resolved only when a method is used. */
const namespace = sole(DURABLE_OBJECT) as DurableObjectNamespace;

export default namespace;
