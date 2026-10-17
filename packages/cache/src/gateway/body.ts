import { MAX_TAG_LENGTH, MAX_TAGS_PER_CALL } from '@stayingupwind/core/cache';
import {
  type BoundedBody,
  decodeUtf8,
  readBoundedBody,
  releaseStream,
} from '@stayingupwind/core/util';
import { MAX_DATA_HANDLER_LENGTH, MAX_DATA_KEY_LENGTH } from '@stayingupwind/host/cache';
import {
  type CheckingSchema,
  type ParseFailure,
  safeParseBounded,
  UNLISTED_MISMATCH,
} from '@stayingupwind/host/util';
import type { Context } from 'hono';

import { describeIssues, fail } from './respond.ts';

/**
 * A request's body, read no further than its route will take.
 *
 * An isolate of the gateway serves every deployment whose requests reach it, and each of them
 * holds the token that opens its own scope — so what a body holds is its sender's to choose, and
 * one read to its end before anything measured it is one deployment deciding how much of that
 * isolate the others are left. The declared length is only the early answer: a body a Worker
 * streams arrives without one, so the bytes are counted as they come and the read stops at the
 * first one past the limit.
 */

/**
 * How long a body may go quiet, and how long it may take whole. Its sender is a Worker holding it
 * in memory already, a service binding or the host's own network away: a pause is a sender that
 * stopped, and the largest body a route takes is seconds of transfer at most.
 */
const BODY_STALL_MS = 10_000;
const BODY_BUDGET_MS = 30_000;
/** `Content-Length` as HTTP writes it; `Number` alone takes `1e3`, `0x10` and the empty string. */
const DIGITS = /^\d+$/u;
const KIB = 1024;
/** The most JSON makes of one code unit of a string: `\u001f`. */
export const JSON_BYTES_PER_CODE_UNIT = 6;
/**
 * What a body holds beside the strings its bound is counted in: the field names and punctuation,
 * the numbers, and the words the contract names or leaves short — a kind, a reason, a cause.
 */
const REST_KIB = 16;
const REST_BYTES = REST_KIB * KIB;

/**
 * How far a body that names an entry is read: the longest key and handler name the data cache
 * stores a value under, however JSON escaped them. A data read, a lease and a resolve carry no
 * more, and a heartbeat or the end of an attempt carries less; a key past its bound was never
 * stored, so a read of one has nothing to find. What the contract bounds nowhere — a route and its
 * pathname, the message an attempt failed with — is held to the same room, which is far more than
 * any of them needs.
 */
export const ENTRY_BODY_BYTES =
  JSON_BYTES_PER_CODE_UNIT * (MAX_DATA_KEY_LENGTH + MAX_DATA_HANDLER_LENGTH) + REST_BYTES;

/** How far a tag read or an invalidation is read: every tag one call may name, at its bound. */
export const TAGS_BODY_BYTES =
  JSON_BYTES_PER_CODE_UNIT * MAX_TAGS_PER_CALL * MAX_TAG_LENGTH + REST_BYTES;

/** The body whole, or the refusal of a length that is not one or of a body past `limit`. */
export async function readBody(
  c: Context,
  limit: number,
  tooLarge: string,
): Promise<Uint8Array | Response> {
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    const length = Number(declared);
    if (!DIGITS.test(declared) || !Number.isSafeInteger(length)) {
      return fail(c, 'invalid_request', 'content-length is not a length');
    }
    if (length > limit) {
      return fail(c, 'too_large', tooLarge);
    }
  }
  let read: BoundedBody;
  try {
    read = await readBoundedBody(c.req.raw.body, {
      limit,
      stallMs: BODY_STALL_MS,
      budgetMs: BODY_BUDGET_MS,
    });
  } catch {
    return fail(c, 'invalid_request', 'the body did not arrive whole');
  }
  if (read.kind === 'over-limit') {
    releaseStream(read.body, 'body past its limit');
    return fail(c, 'too_large', tooLarge);
  }
  return read.bytes;
}

/**
 * The body parsed as JSON, read no further than `limit` first — where `zValidator` would parse
 * whatever arrived, however much that was. The bytes go with the call; only what they parsed to,
 * and how many there were, is handed back.
 */
export async function readJson(
  c: Context,
  limit: number,
  tooLarge: string,
): Promise<Response | { readonly json: unknown; readonly length: number }> {
  const body = await readBody(c, limit, tooLarge);
  if (body instanceof Response) {
    return body;
  }
  try {
    return { json: JSON.parse(decodeUtf8(body)) as unknown, length: body.byteLength };
  } catch {
    return fail(c, 'invalid_request', 'the body is not JSON');
  }
}

/** The refusal of a body its schema did not take: with its issues, where it came with them. */
export function refuseMismatch(c: Context, error: ParseFailure | undefined): Response {
  return fail(
    c,
    'invalid_request',
    error === undefined ? UNLISTED_MISMATCH : describeIssues(error),
  );
}

/**
 * The request `schema` makes of the body, read no further than `limit` first: what `zValidator`
 * answered with, save that a body past the limit is refused before any of it is parsed, one that
 * is not JSON is refused as a bad request rather than failing the call, and one too long for its
 * issues to be listed cheaply is refused without them (`safeParseBounded`).
 */
export async function readRequest<T>(
  c: Context,
  schema: CheckingSchema<T>,
  limit: number,
): Promise<T | Response> {
  const body = await readJson(c, limit, `the body may hold at most ${limit} bytes`);
  if (body instanceof Response) {
    return body;
  }
  const parsed = safeParseBounded(schema, body.json, body.length);
  return parsed.success ? parsed.data : refuseMismatch(c, parsed.error);
}
