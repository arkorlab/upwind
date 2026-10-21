import { sha256Hex } from '@stayingupwind/core/artifact';
import { artifactEncodingSchema, artifactRoleSchema, r2BlobKey } from '@stayingupwind/core/cache';
import { fromBase64, toBase64 } from '@stayingupwind/core/util';
import {
  ARTIFACT_ENCODING_HEADER,
  ARTIFACT_ROLE_HEADER,
  commitRequestSchema,
  failRequestSchema,
  FENCING_TOKEN_HEADER,
  heartbeatRequestSchema,
  MAX_ARTIFACT_BATCH_BYTES,
  MAX_BATCHED_ARTIFACT_BYTES,
  MAX_BATCHED_ARTIFACTS,
  startAttemptRequestSchema,
  uploadArtifactsRequestSchema,
} from '@stayingupwind/host/cache';
import { Hono } from 'hono';
import { z } from 'zod';

import type { RecordedArtifact, UploadedArtifact } from '../../scope/attempts.ts';
import { isRefusal, type Refusal } from '../../scope/state.ts';
import { answerScope, type GatewayContext, type GatewayEnv, meterWrite } from '../auth.ts';
import { ENTRY_BODY_BYTES, inBodyRoom, readBody, readRequest } from '../body.ts';
import { fail, ok } from '../respond.ts';

/**
 * A regeneration, as the application's Worker drives it: take the lease, keep it alive, upload
 * each output's bytes, then commit them as one generation — or say it failed.
 */

const sha256Param = z.string().regex(/^[0-9a-f]{64}$/u);
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const KIB = 1024;
const MIB = KIB * KIB;
const COMMIT_MIB = 1;
/**
 * How far a commit is read. Most of what one carries is headers the edge replays, the
 * generation's own and each output's, and Cloudflare sends no response whose headers come to more
 * than 128 KB in all (Workers limits, "Response header size":
 * https://developers.cloudflare.com/workers/platform/limits/): a commit replaying more could never
 * be delivered. Beside them it carries tags, at most 1,024 of 256 characters, and again with a
 * revision each where it says what its view held of them (`heldTagRevisions`); the outputs' keys
 * and artifacts, which the authority holds with the headers to the 256 KiB of a record's header
 * (`MAX_PACK_HEADER_BYTES`); and dependencies, which the runtime sends none of. A mebibyte is room
 * for all of it. More would buy nothing but memory: `JSON.parse` makes 22 MiB of heap of a mebibyte
 * of `[{},{},…]`, and 89 of four.
 */
export const COMMIT_BODY_BYTES = COMMIT_MIB * MIB;

interface UploadHeaders {
  readonly role: UploadedArtifact['role'];
  readonly encoding: UploadedArtifact['encoding'];
  readonly contentType: string;
  readonly fencingToken: number;
}

/** What the upload's headers say about the bytes, or why they cannot be taken. */
function uploadHeaders(c: GatewayContext): UploadHeaders | Response {
  const role = artifactRoleSchema.safeParse(c.req.header(ARTIFACT_ROLE_HEADER));
  if (!role.success) {
    return fail(c, 'invalid_request', `${ARTIFACT_ROLE_HEADER} must name the artifact's role`);
  }
  const encoding = artifactEncodingSchema.safeParse(
    c.req.header(ARTIFACT_ENCODING_HEADER) ?? 'identity',
  );
  if (!encoding.success) {
    return fail(c, 'invalid_request', `${ARTIFACT_ENCODING_HEADER} is not an encoding`);
  }
  const fencingToken = Number(c.req.header(FENCING_TOKEN_HEADER));
  if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
    return fail(c, 'invalid_request', `${FENCING_TOKEN_HEADER} must be the lease's token`);
  }
  return {
    role: role.data,
    encoding: encoding.data,
    contentType: c.req.header('content-type') ?? DEFAULT_CONTENT_TYPE,
    fencingToken,
  };
}

/** What an upload too large to take is told. */
function tooLargeOf(maxBytes: number): string {
  return `an artifact may hold at most ${maxBytes} bytes`;
}

/**
 * `PUT /attempts/:attemptId/artifacts/:sha256`. The bytes are read no further than an artifact may
 * hold, hashed before anything is written, counted against the scope by the authority before they
 * are stored, and stored under their content so a second upload of the same bytes is a no-op. Read
 * whole and held until then, in room the isolate keeps for such bodies (`inBodyRoom`).
 */
async function uploadArtifact(c: GatewayContext): Promise<Response> {
  const headers = uploadHeaders(c);
  if (headers instanceof Response) {
    return headers;
  }
  const claimed = sha256Param.safeParse(c.req.param('sha256'));
  if (!claimed.success) {
    return fail(c, 'invalid_request', 'the path must name the SHA-256 of the bytes');
  }
  const maxBytes = c.get('vars').MAX_ARTIFACT_BYTES;
  return inBodyRoom(c, maxBytes, tooLargeOf(maxBytes), () =>
    storeArtifact(c, headers, claimed.data),
  );
}

/** The upload's bytes, read whole, checked against the digest `claimed` for them, and stored. */
async function storeArtifact(
  c: GatewayContext,
  headers: UploadHeaders,
  claimed: string,
): Promise<Response> {
  const maxBytes = c.get('vars').MAX_ARTIFACT_BYTES;
  const bytes = await readBody(c, maxBytes, tooLargeOf(maxBytes));
  if (bytes instanceof Response) {
    return bytes;
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== claimed) {
    return fail(
      c,
      'artifact_mismatch',
      'the bytes do not hash to the name they were uploaded under',
    );
  }
  const storageRef = r2BlobKey(c.get('scopeId'), sha256);
  const recorded = await c.get('scope').recordArtifact(
    c.req.param('attemptId') ?? '',
    {
      sha256,
      byteLength: bytes.byteLength,
      contentType: headers.contentType,
      encoding: headers.encoding,
      role: headers.role,
      storageRef,
      fencingToken: headers.fencingToken,
    },
    c.get('now'),
  );
  if (isRefusal(recorded)) {
    return answerScope(c, recorded);
  }
  const target = recorded.storageRef ?? storageRef;
  if (recorded.replace === true || (await c.env.ARTIFACTS.head(target)) === null) {
    // With the digest already taken, for storage to keep: a read compares it, unread (`entries.ts`).
    await c.env.ARTIFACTS.put(target, bytes as BufferSource, {
      sha256,
      httpMetadata: { contentType: headers.contentType },
    });
  }
  return ok(c, { sha256, byteLength: bytes.byteLength });
}

const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARACTERS = 4;
/**
 * How far a batch is read: its artifacts' base64, at a byte a character, and a kibibyte beside each
 * for what names it — its role, its hash, its type.
 */
export const BATCH_BODY_BYTES =
  Math.ceil(MAX_ARTIFACT_BATCH_BYTES / BASE64_GROUP_BYTES) * BASE64_GROUP_CHARACTERS +
  MAX_BATCHED_ARTIFACTS * KIB;

/** An artifact of a batch, decoded and hashed. */
interface DecodedArtifact {
  readonly upload: UploadedArtifact;
  readonly bytes: Uint8Array;
  readonly replace?: true;
}

function decodedBase64(value: string): Uint8Array | undefined {
  try {
    return fromBase64(value);
  } catch {
    return undefined;
  }
}

/** Select each admitted blob once, retaining its first metadata and any later repair request. */
function admittedBlobs(
  decoded: readonly DecodedArtifact[],
  recorded: readonly (RecordedArtifact | Refusal)[],
): Map<string, DecodedArtifact> {
  const blobs = new Map<string, DecodedArtifact>();
  for (const [index, artifact] of decoded.entries()) {
    const answer = recorded[index];
    if (answer === undefined || isRefusal(answer)) continue;
    const storageRef = answer.storageRef ?? artifact.upload.storageRef;
    const first = blobs.get(storageRef);
    if (first !== undefined && answer.replace !== true) continue;
    const selected = first ?? artifact;
    const located =
      selected.upload.storageRef === storageRef
        ? selected
        : { ...selected, upload: { ...selected.upload, storageRef } };
    blobs.set(storageRef, answer.replace === true ? { ...located, replace: true } : located);
  }
  return blobs;
}

/**
 * `POST /attempts/:attemptId/artifacts`. Several of the attempt's small artifacts in one request:
 * each read no further than a batch may hold, decoded and hashed before anything is written,
 * counted against the scope by the authority before any is stored, as one upload's bytes are
 * (`uploadArtifact`), and then stored together, each under its content. Where the authority refuses
 * one, the others it recorded are stored all the same and stay the attempt's, as an upload's does
 * when one beside it is refused, and the refusal is the answer.
 */
async function uploadArtifacts(c: GatewayContext): Promise<Response> {
  const request = await readRequest(c, uploadArtifactsRequestSchema, BATCH_BODY_BYTES);
  if (request instanceof Response) {
    return request;
  }
  const maxBytes = Math.min(c.get('vars').MAX_ARTIFACT_BYTES, MAX_BATCHED_ARTIFACT_BYTES);
  const decoded: DecodedArtifact[] = [];
  let total = 0;
  for (const artifact of request.artifacts) {
    const bytes = decodedBase64(artifact.bytes);
    if (bytes === undefined) {
      return fail(c, 'invalid_request', "an artifact's bytes must be base64");
    }
    total += bytes.byteLength;
    if (bytes.byteLength > maxBytes || total > MAX_ARTIFACT_BATCH_BYTES) {
      return fail(
        c,
        'invalid_request',
        `a batch may hold artifacts of ${maxBytes} bytes, ${MAX_ARTIFACT_BATCH_BYTES} in all`,
      );
    }
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== artifact.sha256) {
      return fail(
        c,
        'artifact_mismatch',
        'the bytes do not hash to the name they were uploaded under',
      );
    }
    const upload: UploadedArtifact = {
      sha256,
      byteLength: bytes.byteLength,
      contentType: artifact.contentType,
      encoding: 'identity',
      role: artifact.role,
      storageRef: r2BlobKey(c.get('scopeId'), sha256),
    };
    decoded.push({ upload, bytes });
  }
  // Asked of the authority together, which takes them one after another: the round trips overlap.
  const attemptId = c.req.param('attemptId') ?? '';
  const recorded = await Promise.all(
    decoded.map(({ upload }) => {
      return c
        .get('scope')
        .recordArtifact(attemptId, { ...upload, fencingToken: request.fencingToken }, c.get('now'));
    }),
  );
  // Each artifact the authority recorded is stored, refused beside another or not, as one upload's
  // bytes are once it is recorded; each blob once, as the first of the batch's artifacts that are
  // its bytes types it, as the first upload of them does.
  const blobs = admittedBlobs(decoded, recorded);
  await Promise.all(
    [...blobs.values()].map(async ({ upload, bytes, replace }) => {
      if (replace === true || (await c.env.ARTIFACTS.head(upload.storageRef)) === null) {
        await c.env.ARTIFACTS.put(upload.storageRef, bytes as BufferSource, {
          sha256: upload.sha256,
          httpMetadata: { contentType: upload.contentType },
        });
      }
    }),
  );
  const refused = recorded.find(isRefusal);
  if (refused !== undefined) {
    return answerScope(c, refused);
  }
  return ok(c, {
    artifacts: decoded.map(({ upload }) => {
      return {
        sha256: upload.sha256,
        byteLength: upload.byteLength,
      };
    }),
  });
}

export const attemptRoutes = new Hono<GatewayEnv>()
  // Not `zValidator`: it parses whatever arrives before anything has measured it.
  .post('/attempts', async (c) => {
    const request = await readRequest(c, startAttemptRequestSchema, ENTRY_BODY_BYTES);
    if (request instanceof Response) {
      return request;
    }
    const outcome = await c.get('scope').startAttempt(request, c.get('now'));
    if (isRefusal(outcome)) {
      return answerScope(c, outcome);
    }
    // The record of a later generation than the one the request judged, where the scope handed it
    // back: the Worker answers from it where KV is behind it.
    const { recordBytes, ...response } = outcome;
    return answerScope(
      c,
      recordBytes === undefined ? response : { ...response, record: toBase64(recordBytes) },
    );
  })
  .post('/attempts/:attemptId/heartbeat', async (c) => {
    const request = await readRequest(c, heartbeatRequestSchema, ENTRY_BODY_BYTES);
    if (request instanceof Response) {
      return request;
    }
    return answerScope(
      c,
      await c.get('scope').heartbeat(c.req.param('attemptId'), request.fencingToken, c.get('now')),
    );
  })
  .put('/attempts/:attemptId/artifacts/:sha256', (c) => uploadArtifact(c))
  .post('/attempts/:attemptId/artifacts', (c) => uploadArtifacts(c))
  .post('/attempts/:attemptId/commit', async (c) => {
    const request = await readRequest(c, commitRequestSchema, COMMIT_BODY_BYTES);
    if (request instanceof Response) {
      return request;
    }
    const outcome = await c.get('scope').commit(c.req.param('attemptId'), request, c.get('now'));
    if (isRefusal(outcome)) {
      return answerScope(c, outcome);
    }
    // What the publish wrote is metered here and kept here: the Worker is told what it is told.
    const { metered, recordBytes, ...response } = outcome;
    if (metered !== undefined) {
      meterWrite(c, metered);
    }
    // The record the commit's settle wrote, where the scope handed it back: the Function keeps it
    // nearer than KV's cache, which goes on answering with the generation it replaced.
    return answerScope(
      c,
      recordBytes === undefined ? response : { ...response, record: toBase64(recordBytes) },
    );
  })
  .post('/attempts/:attemptId/fail', async (c) => {
    const request = await readRequest(c, failRequestSchema, ENTRY_BODY_BYTES);
    if (request instanceof Response) {
      return request;
    }
    return answerScope(
      c,
      await c.get('scope').fail(c.req.param('attemptId'), request, c.get('now')),
    );
  });
