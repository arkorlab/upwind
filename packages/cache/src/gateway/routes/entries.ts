import { deriveEntry, kvGenerationKey } from '@stayingupwind/core/cache';
import { ARTIFACT_SHA256_HEADER, resolveRequestSchema } from '@stayingupwind/host/cache';
import { Hono } from 'hono';

import {
  answerScope,
  type GatewayContext,
  type GatewayEnv,
  refuseRetired,
  retiredScope,
} from '../auth.ts';
import { ENTRY_BODY_BYTES, readRequest } from '../body.ts';
import { fail, HTTP, ok } from '../respond.ts';

/**
 * Reads of what is current. The delivery record is answered from KV — the same record the edge
 * reads, from the same regional cache — and a generation's other outputs from storage, through
 * the authority, which alone knows where an artifact of this scope is.
 */

/** The regional cache the edge reads with; a record changes at most this long after it is written. */
const RECORD_CACHE_TTL_SECONDS = 30;
const OCTET_STREAM = 'application/octet-stream';

async function currentRecord(c: GatewayContext): Promise<Response> {
  const entryId = c.req.param('entryId') ?? '';
  const key = kvGenerationKey(c.get('scopeId'), entryId);
  const [bytes, retired] = await Promise.all([
    c.env.CACHE_STATE.get(key, {
      type: 'arrayBuffer',
      cacheTtl: RECORD_CACHE_TTL_SECONDS,
    }),
    retiredScope(c),
  ]);
  if (retired) {
    return refuseRetired(c);
  }
  if (bytes === null) {
    return fail(c, 'not_found', 'no delivery record for the entry');
  }
  c.get('host').meter.read(c.get('scopeId'), bytes.byteLength);
  return new Response(bytes, {
    status: HTTP.OK,
    headers: { 'content-type': OCTET_STREAM, 'cache-control': 'private, no-store' },
  });
}

async function artifactBytes(c: GatewayContext): Promise<Response> {
  const [location, retired] = await Promise.all([
    c.get('scope').artifact(c.req.param('artifactId') ?? ''),
    retiredScope(c),
  ]);
  if (retired) {
    return refuseRetired(c);
  }
  if (location === undefined) {
    return fail(c, 'not_found', 'no such artifact in the scope');
  }
  const object = await c.env.ARTIFACTS.get(location.storageRef);
  if (object === null) {
    return fail(c, 'artifact_missing', 'the artifact is not in storage');
  }
  c.get('host').meter.read(c.get('scopeId'), location.byteLength);
  return new Response(object.body, {
    status: HTTP.OK,
    headers: {
      'content-type': OCTET_STREAM,
      'content-length': String(location.byteLength),
      [ARTIFACT_SHA256_HEADER]: location.sha256,
      'cache-control': 'private, no-store',
    },
  });
}

export const entryRoutes = new Hono<GatewayEnv>()
  // Not `zValidator`: it parses whatever arrives before anything has measured it.
  .post('/entries/resolve', async (c) => {
    const request = await readRequest(c, resolveRequestSchema, ENTRY_BODY_BYTES);
    if (request instanceof Response) {
      return request;
    }
    const { entryId } = await deriveEntry(c.get('scopeId'), request.entry);
    const [resolved, retired] = await Promise.all([
      c.get('scope').resolve(entryId),
      retiredScope(c),
    ]);
    return retired ? refuseRetired(c) : answerScope(c, resolved);
  })
  .get('/entries/:entryId/record', (c) => currentRecord(c))
  .get('/generations/:generationId', async (c) => {
    const [generation, retired] = await Promise.all([
      c.get('scope').generation(c.req.param('generationId')),
      retiredScope(c),
    ]);
    if (retired) {
      return refuseRetired(c);
    }
    return generation === undefined
      ? fail(c, 'not_found', 'no such generation')
      : ok(c, { generation });
  })
  .get('/artifacts/:artifactId', (c) => artifactBytes(c));
