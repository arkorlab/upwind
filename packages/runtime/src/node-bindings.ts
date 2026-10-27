import type { FunctionEnv } from '@stayingupwind/core/paas';

import { nativeFetch } from './cache/native.ts';
import { fetchedResponse } from './node-fetch-response.ts';
import { removeNodeControlHeaders } from './node-http.ts';
import { nodeOidcCapability } from './node-oidc.ts';

/** No platform credential is carried into the application process. */
export interface NodeRuntimeConfiguration {
  readonly v: 1;
  readonly deploymentId: string;
  readonly functionName: string;
  readonly controlToken: string;
  readonly capabilities: {
    readonly cacheWrite?: string;
    readonly cacheRead?: string;
    readonly prefetch?: string;
    readonly monitor?: string;
    readonly oidc?: string;
    readonly services: Readonly<Record<string, string>>;
  };
}

const MAX_CONFIGURATION_BYTES = 65_536;
const MAX_TEXT_LENGTH = 1024;
const MIN_CONTROL_TOKEN_LENGTH = 32;
const DELEGATED = 'delegated';
const HOST = /^[a-f0-9]{32}\.[a-f0-9]{32}\.arkor\.internal$/u;
const NAME = /^[A-Za-z_]\w{0,127}$/u;
const INVALID_CONFIGURATION = 'invalid Node runtime configuration';
const INVALID_CAPABILITY = 'invalid Node runtime capability';
const BOOTSTRAP_ENV = 'ARKOR_NODE_RUNTIME';
const RESERVED_SERVICE_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function capability(value: unknown): value is string {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      HOST.test(url.hostname) &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function validateCapabilities(caps: unknown): void {
  if (!record(caps) || !record(caps['services'])) {
    throw new Error('invalid Node runtime capabilities');
  }
  for (const key of ['cacheWrite', 'cacheRead', 'prefetch', 'monitor', 'oidc']) {
    if (caps[key] !== undefined && !capability(caps[key])) {
      throw new Error(INVALID_CAPABILITY);
    }
  }
  if (caps['cacheRead'] !== undefined && caps['cacheWrite'] === undefined) {
    throw new Error('invalid Node runtime cache capability');
  }
  const services = Object.entries(caps['services']);
  for (const [name, url] of services) {
    if (
      !NAME.test(name) ||
      RESERVED_SERVICE_NAMES.has(name) ||
      name.startsWith('ARKOR_') ||
      name.startsWith('NEXT_') ||
      !capability(url)
    ) {
      throw new Error('invalid Node runtime service');
    }
  }
}

function identity(value: Record<string, unknown>): boolean {
  return (
    value['v'] === 1 &&
    text(value['deploymentId']) &&
    text(value['functionName']) &&
    text(value['controlToken']) &&
    value['controlToken'].length >= MIN_CONTROL_TOKEN_LENGTH
  );
}

/** Reject malformed bootstrap input before evaluating any application module. */
export function parseNodeRuntimeConfiguration(raw: string | undefined): NodeRuntimeConfiguration {
  if (raw === undefined || raw.length > MAX_CONFIGURATION_BYTES) {
    throw new Error(INVALID_CONFIGURATION);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(INVALID_CONFIGURATION);
  }
  if (!record(value) || !identity(value)) throw new Error(INVALID_CONFIGURATION);
  validateCapabilities(value['capabilities']);
  return value as unknown as NodeRuntimeConfiguration;
}

/** A Fetcher facade uses captured native fetch, never Next's patched fetch/data cache. */
async function fetchCapability(request: Request): Promise<Response> {
  return fetchedResponse(await nativeFetch(request, { redirect: 'manual' }), request.method);
}

export function nodeCapabilityFetcher(
  origin: string,
  service = false,
): { readonly fetch: typeof fetch } {
  if (!capability(origin)) throw new Error(INVALID_CAPABILITY);
  return Object.freeze({
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const source = new URL(request.url);
      const target = new URL(origin);
      target.pathname = source.pathname;
      target.search = source.search;
      const forwarded = new Request(target, request);
      removeNodeControlHeaders(forwarded.headers);
      if (service) {
        if (source.protocol !== 'http:' && source.protocol !== 'https:') {
          throw new Error('invalid Node service URL');
        }
        forwarded.headers.set('x-upwind-service-url', source.href);
      }
      return fetchCapability(forwarded);
    },
  });
}

export function createNodeFunctionEnv(config: NodeRuntimeConfiguration): FunctionEnv {
  const env: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== BOOTSTRAP_ENV) env[name] = value;
  }
  const caps = config.capabilities;
  env['ARKOR_RUNTIME'] = 'node-container';
  env['NEXT_DEPLOYMENT_ID'] = config.deploymentId;
  env['NEXT_PRIVATE_RESPONSE_CACHE_TTL'] = '1';
  if (caps.cacheWrite !== undefined) {
    env['ARKOR_CACHE_TOKEN'] = DELEGATED;
    env['ARKOR_CACHE_GATEWAY_URL'] = caps.cacheWrite;
    env['ARKOR_CACHE'] = nodeCapabilityFetcher(caps.cacheWrite);
  }
  if (caps.cacheRead !== undefined) {
    env['ARKOR_CACHE_READ_GATEWAY_URL'] = caps.cacheRead;
    env['ARKOR_CACHE_READ'] = nodeCapabilityFetcher(caps.cacheRead);
  }
  if (caps.prefetch !== undefined) env['ARKOR_PREFETCH'] = nodeCapabilityFetcher(caps.prefetch);
  if (caps.monitor !== undefined) {
    env['ARKOR_MONITOR'] = nodeCapabilityFetcher(caps.monitor);
    env['ARKOR_MONITOR_TOKEN'] = DELEGATED;
  }
  if (caps.oidc !== undefined)
    env['ARKOR_OIDC'] = nodeOidcCapability(nodeCapabilityFetcher(caps.oidc));
  for (const [name, url] of Object.entries(caps.services))
    env[name] = nodeCapabilityFetcher(url, true);
  env['ARKOR_RESOURCES'] = JSON.stringify(
    Object.keys(caps.services).map((name) => ({ name, type: 'service' })),
  );
  return Object.freeze(env);
}

const cached: {
  configuration: NodeRuntimeConfiguration | undefined;
  environment: FunctionEnv | undefined;
} = { configuration: undefined, environment: undefined };

export function nodeRuntimeConfiguration(): NodeRuntimeConfiguration {
  const raw = process.env[BOOTSTRAP_ENV];
  Reflect.deleteProperty(process.env, BOOTSTRAP_ENV);
  cached.configuration ??= parseNodeRuntimeConfiguration(raw);
  return cached.configuration;
}

export function nodeFunctionEnv(): FunctionEnv {
  cached.environment ??= createNodeFunctionEnv(nodeRuntimeConfiguration());
  return cached.environment;
}
