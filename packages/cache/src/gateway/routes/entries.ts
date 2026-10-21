import { deriveEntry, kvGenerationKey } from '@stayingupwind/core/cache';
import { releaseStream, toHex } from '@stayingupwind/core/util';
import { ARTIFACT_SHA256_HEADER, resolveRequestSchema } from '@stayingupwind/host/cache';
import { Hono } from 'hono';

import { createLogger, detailOf } from '../../logger.ts';
import type { ArtifactLocation } from '../../scope/reads.ts';
import {
  answerScope,
  type GatewayContext,
  type GatewayEnv,
  refuseRetired,
  retiredScope,
} from '../auth.ts';
import { ENTRY_BODY_BYTES, readRequest } from '../body.ts';
import { meterRead } from '../read-data.ts';
import {
  dropRecordAnswer,
  dropRecordWhenRead,
  readRecordAnswer,
  type RecordAnswer,
  recordResponse,
} from '../record-answer.ts';
import { fail, HTTP, ok } from '../respond.ts';

/**
 * Reads of what is current. The delivery record is answered from KV — the same record the edge
 * reads, from the same regional cache — and a generation's other outputs from storage, through
 * the authority, which alone knows where an artifact of this scope is.
 */

const OCTET_STREAM = 'application/octet-stream';
const OTHER_BYTES = 'the stored artifact is not the bytes its authority names';

const logger = createLogger({ component: 'gateway' });

async function currentRecord(c: GatewayContext): Promise<Response> {
  const entryId = c.req.param('entryId') ?? '';
  const scopeId = c.get('scopeId');
  const key = kvGenerationKey(scopeId, entryId);
  const reading = readRecordAnswer(c.env.CACHE_STATE, key, scopeId, entryId);
  let record: RecordAnswer | undefined;
  let retired: boolean;
  try {
    [record, retired] = await Promise.all([reading, retiredScope(c)]);
  } catch (error) {
    dropRecordWhenRead(reading);
    throw error;
  }
  if (retired) {
    dropRecordAnswer(record);
    return refuseRetired(c);
  }
  if (record === undefined) {
    return fail(c, 'not_found', 'no delivery record for the entry');
  }
  meterRead(c.get('host'), c.get('scopeId'), record.byteLength);
  return recordResponse(record);
}

/**
 * Whether storage holds other bytes than the authority names, by the digest it keeps of an object
 * written with one (Codex): compared as it stands, with nothing of the body read, so a read that
 * passes waits on no hash of tens of MiB. An object written without one says nothing either way,
 * and is answered as its length allows, as it always was; the Function still hashes what it keeps
 * of it, behind the response.
 */
function storedOtherBytes(object: R2ObjectBody, sha256: string): boolean {
  const stored = object.checksums.sha256;
  return stored !== undefined && toHex(new Uint8Array(stored)) !== sha256;
}

/**
 * Tell the authority of an artifact storage holds other bytes for, so that the next upload of the
 * bytes repairs it (`rememberCorruptArtifact`). The read is refused whether or not it is told: a
 * failure to tell it is logged, and the next read that finds the same tries again. One the
 * authority has moved since its location was read is no longer the artifact's, and is said.
 */
async function reportOtherBytes(c: GatewayContext, location: ArtifactLocation): Promise<void> {
  try {
    if (!(await c.get('scope').rememberCorruptArtifact(location))) {
      logger.warn('corrupt artifact moved before it was reported', {
        scopeId: c.get('scopeId'),
        sha256: location.sha256,
      });
    }
  } catch (error) {
    logger.error('corrupt artifact not reported', {
      scopeId: c.get('scopeId'),
      sha256: location.sha256,
      detail: detailOf(error),
    });
  }
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
  if (object.size !== location.byteLength) {
    releaseStream(object.body, 'the stored artifact length differs from its authority');
    return fail(c, 'artifact_mismatch', 'the stored artifact length differs from its authority');
  }
  // Refused before a byte of it goes out, rather than served and found out by a hash behind the
  // response, which a runtime holding the bytes meanwhile would never hear of.
  if (storedOtherBytes(object, location.sha256)) {
    releaseStream(object.body, OTHER_BYTES);
    await reportOtherBytes(c, location);
    return fail(c, 'artifact_mismatch', OTHER_BYTES);
  }
  meterRead(c.get('host'), c.get('scopeId'), location.byteLength);
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
