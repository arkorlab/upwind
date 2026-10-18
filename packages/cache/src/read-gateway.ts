import { kvGenerationKey } from '@stayingupwind/core/cache';
import {
  dataGetRequestSchema,
  GATEWAY_API_VERSION,
  tagsGetRequestSchema,
} from '@stayingupwind/host/cache';
import { Hono, type MiddlewareHandler } from 'hono';

import type { AuthorityHost } from './authority-host.ts';
import { ENTRY_BODY_BYTES, readRequest, TAGS_BODY_BYTES } from './gateway/body.ts';
import { dataReadBytes, meterRead, readDataRecord } from './gateway/read-data.ts';
import { readTagRecords } from './gateway/read-tags.ts';
import {
  dropRecordAnswer,
  dropRecordWhenRead,
  readRecordAnswer,
  type RecordAnswer,
  recordResponse,
} from './gateway/record-answer.ts';
import { fail, ok } from './gateway/respond.ts';
import { scopeRetired } from './gateway/retirement.ts';
import { tokenCheckOf, type TokenKeys } from './gateway/token.ts';

/** No regional bindings or placement: a cache hit is read in the caller's region. */
export interface ReadBindings extends TokenKeys {
  readonly CACHE_STATE: KVNamespace;
}

interface ReadEnv {
  Bindings: ReadBindings;
  Variables: { scopeId: string };
}

const SCOPE_PREFIX = `/${GATEWAY_API_VERSION}/scopes/:scope`;

/** The token check every read is behind, under what the host decided (`AuthorityHost`). */
function readAuthOf(host: AuthorityHost): MiddlewareHandler<ReadEnv> {
  const authorizedScope = tokenCheckOf(host.naming);
  return async (c, next): Promise<Response | undefined> => {
    const scopeId = c.req.param('scope') ?? '';
    if (!(await authorizedScope(c.req.raw, scopeId, c.env))) {
      return fail(c, 'unauthorized', 'the token does not open this scope');
    }
    c.set('scopeId', scopeId);
    c.header('cache-control', 'private, no-store');
    await next();
    return undefined;
  };
}

/** The read gateway under what a host decided for its authority; made once, at module scope. */
export function createReadGateway(host: AuthorityHost): Hono<ReadEnv> {
  return (
    new Hono<ReadEnv>()
      .onError((_error, c) => fail(c, 'internal', 'internal error'))
      .notFound((c) => fail(c, 'not_found', 'no such endpoint'))
      .get(`/${GATEWAY_API_VERSION}/healthz`, (c) => c.json({ ok: true as const }))
      .use(`${SCOPE_PREFIX}/*`, readAuthOf(host))
      // Not `zValidator`: it parses whatever arrives before anything has measured it, in the one
      // isolate every deployment's reads share.
      .post(`${SCOPE_PREFIX}/data/get`, async (c) => {
        const request = await readRequest(c, dataGetRequestSchema, ENTRY_BODY_BYTES);
        if (request instanceof Response) {
          return request;
        }
        const scopeId = c.get('scopeId');
        // Beside the record, once the body is in, as the authority's gateway reads it: a marker read
        // before a body that took long would say where the scope stood before the record was read.
        const [record, retired] = await Promise.all([
          readDataRecord(c.env.CACHE_STATE, scopeId, request),
          scopeRetired(c.env.CACHE_STATE, scopeId),
        ]);
        if (retired) {
          return fail(c, 'scope_retired', 'the scope is retired');
        }
        if (record === undefined) {
          return fail(c, 'not_found', 'no record for the key');
        }
        meterRead(host, scopeId, dataReadBytes(record));
        return ok(c, record);
      })
      // A tag read opens nothing, so the marker guards nothing there, and the render judging a value
      // it read would wait for it.
      .post(`${SCOPE_PREFIX}/tags/get`, async (c) => {
        const request = await readRequest(c, tagsGetRequestSchema, TAGS_BODY_BYTES);
        return request instanceof Response
          ? request
          : ok(c, await readTagRecords(c.env.CACHE_STATE, c.get('scopeId'), request.tags));
      })
      .get(`${SCOPE_PREFIX}/entries/:entryId/record`, async (c) => {
        const scopeId = c.get('scopeId');
        const key = kvGenerationKey(scopeId, c.req.param('entryId'));
        const reading = readRecordAnswer(c.env.CACHE_STATE, key);
        let record: RecordAnswer | undefined;
        let retired: boolean;
        try {
          [record, retired] = await Promise.all([
            reading,
            scopeRetired(c.env.CACHE_STATE, scopeId),
          ]);
        } catch (error) {
          dropRecordWhenRead(reading);
          throw error;
        }
        if (retired) {
          dropRecordAnswer(record);
          return fail(c, 'scope_retired', 'the scope is retired');
        }
        if (record === undefined) {
          return fail(c, 'not_found', 'no delivery record for the entry');
        }
        meterRead(host, scopeId, record.byteLength);
        return recordResponse(record);
      })
  );
}

/** The read gateway's Worker: the gateway, answering every read it is sent. */
export function createReadWorker(app: Hono<ReadEnv>): ExportedHandler<ReadBindings> {
  return {
    fetch: (request, env, ctx): Promise<Response> => Promise.resolve(app.fetch(request, env, ctx)),
  };
}
