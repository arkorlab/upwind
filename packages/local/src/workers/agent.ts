import type { DeployCache } from '@stayingupwind/deploy/deploy';
import { seedEntriesInputSchema, seedScopeInputSchema } from '@stayingupwind/host/cache';

import { AGENT_ROUTES, METADATA_HEADER } from './protocol.ts';

/**
 * What deploys to the stack, on the stack's side of a socket: the edge's namespace and the bucket,
 * read and written as a deploy reads and writes them, and the cache authority's control entrypoint,
 * called as a deploy calls it. Only the host deployment client holds this stack's credential.
 */
interface AgentEnv {
  readonly DEPLOY_AGENT_TOKEN: string;
  readonly EDGE_STATE: KVNamespace;
  readonly ARTIFACTS: R2Bucket;
  readonly CACHE_CONTROL: DeployCache;
}

const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;

function empty(status: number): Response {
  return new Response(null, { status });
}

function metadataOf(request: Request): unknown {
  const raw = request.headers.get(METADATA_HEADER);
  return raw === null ? undefined : JSON.parse(decodeURIComponent(raw));
}

/** An object's custom metadata, which holds strings only. */
function stringsOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

async function kv(request: Request, env: AgentEnv, key: string): Promise<Response> {
  if (request.method === 'GET') {
    const value = await env.EDGE_STATE.get(key, 'arrayBuffer');
    return value === null ? empty(HTTP_NOT_FOUND) : new Response(value);
  }
  if (request.method === 'PUT') {
    const metadata = metadataOf(request);
    await env.EDGE_STATE.put(
      key,
      await request.arrayBuffer(),
      metadata === undefined ? {} : { metadata },
    );
    return empty(HTTP_NO_CONTENT);
  }
  return empty(HTTP_METHOD_NOT_ALLOWED);
}

async function blob(request: Request, env: AgentEnv, key: string): Promise<Response> {
  if (request.method === 'GET') {
    const object = await env.ARTIFACTS.get(key);
    return object === null ? empty(HTTP_NOT_FOUND) : new Response(object.body);
  }
  if (request.method === 'PUT') {
    const contentType = request.headers.get('content-type');
    const customMetadata = stringsOf(metadataOf(request));
    await env.ARTIFACTS.put(key, await request.arrayBuffer(), {
      ...(contentType !== null && { httpMetadata: { contentType } }),
      ...(customMetadata !== undefined && { customMetadata }),
    });
    return empty(HTTP_NO_CONTENT);
  }
  return empty(HTTP_METHOD_NOT_ALLOWED);
}

async function seed(request: Request, env: AgentEnv, pathname: string): Promise<Response> {
  if (request.method !== 'POST') {
    return empty(HTTP_METHOD_NOT_ALLOWED);
  }
  const input: unknown = await request.json();
  switch (pathname) {
    case AGENT_ROUTES.seedScope: {
      return Response.json(await env.CACHE_CONTROL.seedScope(seedScopeInputSchema.parse(input)));
    }
    case AGENT_ROUTES.seedEntries: {
      return Response.json(
        await env.CACHE_CONTROL.seedEntries(seedEntriesInputSchema.parse(input)),
      );
    }
    default: {
      return empty(HTTP_NOT_FOUND);
    }
  }
}

export default {
  fetch(request, env): Promise<Response> {
    // This bearer is generated once with 256 bits of entropy and is never bound to app Workers.
    // eslint-disable-next-line security/detect-possible-timing-attacks -- unguessable per-stack capability, checked before any operation.
    if (
      !env.DEPLOY_AGENT_TOKEN ||
      request.headers.get('authorization') !== `Bearer ${env.DEPLOY_AGENT_TOKEN}`
    ) {
      return Promise.resolve(empty(HTTP_UNAUTHORIZED));
    }
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(AGENT_ROUTES.kv)) {
      return kv(request, env, decodeURIComponent(pathname.slice(AGENT_ROUTES.kv.length)));
    }
    if (pathname.startsWith(AGENT_ROUTES.blob)) {
      return blob(request, env, decodeURIComponent(pathname.slice(AGENT_ROUTES.blob.length)));
    }
    return seed(request, env, pathname);
  },
} satisfies ExportedHandler<AgentEnv>;
