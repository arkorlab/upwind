import type { MiddlewareMatcher } from '@stayingupwind/core/manifest';
import {
  EDGE_BYPASS_COOKIE,
  HOP_BY_HOP_HEADERS,
  INTERNAL_REQUEST_HEADER_PREFIXES,
  INTERNAL_REQUEST_HEADERS,
  MIDDLEWARE_PREFETCH_HEADER,
} from '@stayingupwind/core/request';
import type { HostCredentials } from '@stayingupwind/host/credentials';

type Condition = NonNullable<MiddlewareMatcher['has']>[number];

/** Whether taking off the host's credentials can change what a condition reads. */
export function readsCredentials(condition: Condition, credentials: HostCredentials): boolean {
  if (condition.type !== 'cookie' && condition.type !== 'header') {
    return false;
  }
  const name = condition.type === 'cookie' ? 'cookie' : (condition.key ?? '').toLowerCase();
  return (
    (name === 'cookie' && credentials.cookies.length > 0) ||
    credentials.headers.some((header) => header.toLowerCase() === name)
  );
}

/**
 * Whether forwarding can change a condition's value (`sanitizePassthroughHeaders`): removed
 * internal headers, forwarding values and Via supplied by the edge, or its recovery cookie.
 * A condition on the Cookie header whole also sees its serialization after that cookie is removed.
 */
export function readsForwarding(condition: Condition): boolean {
  if (condition.type === 'cookie') {
    return condition.key === EDGE_BYPASS_COOKIE;
  }
  if (condition.type !== 'header') {
    return false;
  }
  const name = (condition.key ?? '').toLowerCase();
  return (
    name === 'cookie' ||
    name === 'via' ||
    HOP_BY_HOP_HEADERS.includes(name) ||
    INTERNAL_REQUEST_HEADERS.includes(name) ||
    (name !== MIDDLEWARE_PREFETCH_HEADER &&
      INTERNAL_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)))
  );
}
