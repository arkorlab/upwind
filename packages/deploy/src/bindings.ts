import {
  CACHE_GATEWAY_URL_BINDING,
  CACHE_READ_GATEWAY_URL_BINDING,
  CACHE_READ_SERVICE_BINDING,
  CACHE_SERVICE_BINDING,
  CACHE_TOKEN_BINDING,
  DEPLOYMENT_ID_BINDING,
  PREFETCH_SERVICE_BINDING,
  RESPONSE_CACHE_TTL_BINDING,
  RESPONSE_CACHE_TTL_MS,
  RUNTIME_BINDING,
  RUNTIME_NAME,
} from '@stayingupwind/host/bindings';

/**
 * What every Function of a deployment is bound to by whatever deploys it, beside the application's
 * own environment: its deployment's id, the runtime it is in, the way to its runtime cache, and the
 * way to the blobs its build left out of it.
 */

/** A variable a Function is given: plain text, or a secret. */
export interface TextBinding {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

/** Another Worker a Function reaches without going out to the internet, at its default entrypoint. */
export interface ServiceBinding {
  readonly name: string;
  readonly service: string;
}

/**
 * One way to reach one of the host's own Workers from a deployment's Worker: a service binding to
 * it, or its public URL for a deployment that binds nothing.
 */
export type GatewayRoute =
  | { readonly kind: 'service'; readonly service: string }
  | { readonly kind: 'url'; readonly url: string };

/** What a deployment's Workers are given to reach their runtime cache. */
export interface CacheGrant {
  readonly gateway: GatewayRoute;
  readonly readGateway?: GatewayRoute | undefined;
  /** Opens the deployment's own scope and no other; a secret binding on the Workers. */
  readonly token: string;
}

/**
 * The cache gateways as the deployment's Workers will see them: a service binding, or the URL to
 * go out to, per gateway and never both.
 *
 * Never both is the point. A Worker that held the public name of a gateway beside a binding to it
 * would still have somewhere to go when the binding failed, and a cache Worker reached by binding
 * need answer no public name — the request would leave the host and find nothing. One transport,
 * so a failure to reach the authority is a failure and not a silent detour.
 */
export function cacheBindings(grant: CacheGrant): {
  readonly text: readonly TextBinding[];
  readonly services: readonly ServiceBinding[];
} {
  const text: TextBinding[] = [];
  const services: ServiceBinding[] = [];
  const route = (
    gateway: GatewayRoute | undefined,
    serviceBinding: string,
    urlBinding: string,
  ): void => {
    if (gateway === undefined) {
      return;
    }
    if (gateway.kind === 'service') {
      // No `entrypoint`: the default one is the only one placement acts on.
      services.push({ name: serviceBinding, service: gateway.service });
      return;
    }
    text.push({ name: urlBinding, value: gateway.url, secret: false });
  };
  route(grant.gateway, CACHE_SERVICE_BINDING, CACHE_GATEWAY_URL_BINDING);
  route(grant.readGateway, CACHE_READ_SERVICE_BINDING, CACHE_READ_GATEWAY_URL_BINDING);
  return { text, services };
}

/**
 * What every Function of a deployment is bound to beside its environment, in the order it is bound
 * in: Next.js's deployment id, the runtime, the way to the cache and the token that opens the
 * deployment's own scope, and the response cache's lifetime. A deployment without a runtime cache
 * is given no way to one and no token: it has no scope to open. The prefetch Worker follows the
 * cache's services, where the host runs one.
 */
export function functionBindings(input: {
  readonly deploymentId: string;
  /** What the deployment's Functions reach their runtime cache with; none for a host that runs none. */
  readonly cache?: CacheGrant | undefined;
  /**
   * The service name of the Worker a Function reads a blob its build left out of it from
   * (`PREFETCH_SERVICE_BINDING`) — a build without its prefetch segments falls back to it for a
   * prefetch the edge did not serve; none for a host that runs none.
   */
  readonly prefetch?: string | undefined;
}): {
  readonly text: readonly TextBinding[];
  readonly services: readonly ServiceBinding[];
} {
  const { cache } = input;
  const reached = cache === undefined ? { text: [], services: [] } : cacheBindings(cache);
  const token: TextBinding[] =
    cache === undefined ? [] : [{ name: CACHE_TOKEN_BINDING, value: cache.token, secret: true }];
  return {
    text: [
      { name: DEPLOYMENT_ID_BINDING, value: input.deploymentId, secret: false },
      { name: RUNTIME_BINDING, value: RUNTIME_NAME, secret: false },
      ...reached.text,
      ...token,
      { name: RESPONSE_CACHE_TTL_BINDING, value: RESPONSE_CACHE_TTL_MS, secret: false },
    ],
    services: [
      ...reached.services,
      ...(input.prefetch === undefined
        ? []
        : [{ name: PREFETCH_SERVICE_BINDING, service: input.prefetch }]),
    ],
  };
}
