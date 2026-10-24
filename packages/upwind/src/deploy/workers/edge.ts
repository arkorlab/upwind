import { handleStandalone, type StandaloneEnv } from '@stayingupwind/edge/standalone';

import { fireCronJobs } from './cron-jobs.ts';
import { cronsBindingName, READINESS_PATH, type Readiness } from './protocol.ts';

/**
 * The edge, as `upwind deploy` puts it on an account: `@stayingupwind/edge`'s standalone edge,
 * with one path answered in front of it.
 *
 * A deploy uploads each deployment's edge as a version that takes no traffic, and has to know,
 * before it gives that version any, that the version answering is the one it uploaded and that it
 * serves the deployment it was uploaded for. Cloudflare routes a request to a version that holds no
 * traffic when it is asked to by name, and routes it to another without saying so when it cannot —
 * so the version has to say which it is. `READINESS_PATH` is where it does: the deployment its
 * pinned pointer names, the version Cloudflare says it is, and whether the manifest that deployment
 * is served by is in place.
 *
 * Every other request is the standalone edge's. What a visitor's request pays for this is one
 * search of its URL for the path, with nothing awaited and nothing read; the pointer is read for
 * readiness alone, and only on that path.
 *
 * The deployment's cron jobs are fired from here too, on the edge's Cron Triggers (`scheduled`):
 * each a GET of its path on the site, through the standalone edge as a visitor's request goes, so
 * that it reaches the route as one would. Nothing of that is on a visitor's way.
 */

interface DeployEdgeEnv extends StandaloneEnv {
  /** The version that is running, as Cloudflare numbers it. */
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata | undefined;
  /** What each job is sent as a bearer token, where the project set it. */
  readonly CRON_SECRET?: string | undefined;
}

/** What the pinned pointer names, read loosely: readiness reports it, and judges nothing by it. */
function pointed(env: DeployEdgeEnv): { deploymentId?: string; manifestId?: string } {
  if (env.POINTER === undefined) {
    return {};
  }
  try {
    const pointer: unknown = JSON.parse(env.POINTER);
    if (typeof pointer !== 'object' || pointer === null) {
      return {};
    }
    const manifestId: unknown = Reflect.get(pointer, 'manifestId');
    const app: unknown = Reflect.get(pointer, 'app');
    const deploymentId: unknown =
      typeof app === 'object' && app !== null ? Reflect.get(app, 'deploymentId') : undefined;
    return {
      ...(typeof manifestId === 'string' && { manifestId }),
      ...(typeof deploymentId === 'string' && { deploymentId }),
    };
  } catch {
    return {};
  }
}

/** Whether the manifest is in the namespace the edge reads it from first. */
async function inNamespace(env: DeployEdgeEnv, manifestId: string): Promise<boolean> {
  return (await env.EDGE_STATE.get(`manifest:${manifestId}`, 'arrayBuffer')) !== null;
}

/** Whether the manifest is in the bucket behind the namespace. */
async function inBucket(env: DeployEdgeEnv, manifestId: string): Promise<boolean> {
  return (await env.ARTIFACTS.head(`manifests/${manifestId}.json`)) !== null;
}

async function readiness(env: DeployEdgeEnv): Promise<Response> {
  const { deploymentId, manifestId } = pointed(env);
  const [kv, r2] =
    manifestId === undefined
      ? [false, false]
      : await Promise.all([inNamespace(env, manifestId), inBucket(env, manifestId)]);
  const said: Readiness = {
    deploymentId,
    manifestId,
    versionId: env.CF_VERSION_METADATA?.id,
    manifest: { kv, r2 },
  };
  return Response.json(said, { headers: { 'cache-control': 'no-store' } });
}

/** Every part of the deployment's cron jobs the version holds: `CRONS`, `CRONS_2`… until one is not. */
function cronTables(env: DeployEdgeEnv): string[] {
  const parts: string[] = [];
  let part: unknown = Reflect.get(env, cronsBindingName(0));
  while (typeof part === 'string') {
    parts.push(part);
    part = Reflect.get(env, cronsBindingName(parts.length));
  }
  return parts;
}

export default {
  fetch: (request, env, ctx): Promise<Response> => {
    if (request.url.includes(READINESS_PATH) && new URL(request.url).pathname === READINESS_PATH) {
      return readiness(env);
    }
    return handleStandalone(request, env, ctx);
  },
  scheduled: (controller, env, ctx): Promise<void> => {
    // One attempt, as Vercel makes one: what failed is said, and not tried again.
    controller.noRetry();
    return fireCronJobs({
      trigger: controller.cron,
      tables: cronTables(env),
      hostnames: env.HOSTNAMES,
      secret: env.CRON_SECRET,
      // A request made here carries no `cf`, which the edge reads where it is there and does
      // without where it is not.
      send: (request) =>
        handleStandalone(request as Parameters<typeof handleStandalone>[0], env, ctx),
    });
  },
} satisfies ExportedHandler<DeployEdgeEnv>;
