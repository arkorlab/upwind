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
  jsonValuesWithin,
  type ParseFailure,
  safeParseBounded,
  UNLISTED_MISMATCH,
} from '@stayingupwind/host/util';
import type { Context } from 'hono';

import { withBodyRoom } from './body-room.ts';
import { describeIssues, fail } from './respond.ts';

/**
 * A request's body, read no further than its route will take.
 *
 * An isolate of the gateway serves every deployment whose requests reach it, and each of them
 * holds the token that opens its own scope — so what a body holds is its sender's to choose, and
 * one read to its end before anything measured it is one deployment deciding how much of that
 * isolate the others are left. The declared length is only the early answer: a body a Worker
 * streams arrives without one, so the bytes are counted as they come and the read stops at the
 * first one past the limit. It stops past the declared length too: a synthetic request can
 * understate what its body holds, which admission otherwise takes no room for (Codex). The bodies
 * a write is read whole for, as long as an artifact may be,
 * are read in room the isolate keeps for them (`inBodyRoom`), unless they say they hold a mebibyte
 * or less.
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
 * How many values a JSON body may hold. Long strings cost about what they weigh; many small values
 * make far more of the isolate than their bytes — 22 MiB for a mebibyte of `[{},{},…]` — before a
 * schema has anything to refuse. A commit can hold that many valid headers as well, and its place
 * in the scope's queue keeps what validation made of them until its turn (Codex). This bounds that
 * expansion before the parse, with room beyond a write's 1,024 tags, held tag revisions and other
 * metadata. A shorter body needs no count: each byte counted opens or separates a value, so it
 * cannot hold more of them than it has bytes. Body admission keeps its separate mebibyte boundary.
 */
const MAX_JSON_VALUES = 16_384;

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

/**
 * How long a write waits for room for its body before it is refused (`inBodyRoom`): as long as a
 * body may go quiet. A body waiting for room is, to its sender, one the gateway has stopped
 * reading; the writes ahead of it give their room back once stored, or once a body of theirs that
 * stopped is given up.
 */
const ROOM_WAIT_MS = BODY_STALL_MS;

/**
 * As long as the body may be: the length it declares, or `limit` where it declares none; or the
 * refusal of a length that is not one, or that is past `limit`.
 */
function lengthOf(
  c: Context,
  limit: number,
  tooLarge: string,
): Response | { readonly most: number } {
  const declared = c.req.header('content-length');
  if (declared === undefined) {
    return { most: limit };
  }
  const length = Number(declared);
  if (!DIGITS.test(declared) || !Number.isSafeInteger(length)) {
    return fail(c, 'invalid_request', 'content-length is not a length');
  }
  return length > limit ? fail(c, 'too_large', tooLarge) : { most: length };
}

/**
 * What `write` answers, made in the room the isolate keeps for the bodies it reads whole for a
 * write (`body-room.ts`): taken before any of the body is read, by the length it declares, or by
 * `limit` where it declares none, and given back once `write` is done, whatever it came to. A body
 * that declares a mebibyte or less takes none (`UNCOUNTED_BODY_BYTES`), and is read at once. Where
 * none came within `ROOM_WAIT_MS`, the write is refused as one to make again later, its body
 * unread: a write the Function makes after a render, which costs a later render, not a response.
 * A body whose length is refused (`readBody`) is refused before it waits.
 */
export function inBodyRoom<T>(
  c: Context,
  limit: number,
  tooLarge: string,
  write: () => Promise<T | Response>,
): Promise<T | Response> {
  const length = lengthOf(c, limit, tooLarge);
  if (length instanceof Response) {
    return Promise.resolve(length);
  }
  return withBodyRoom<T | Response>(length.most, ROOM_WAIT_MS, write, () =>
    fail(c, 'quota_exceeded', 'the gateway is holding as many bodies as it has room for'),
  );
}

/** The body whole, or the refusal of a length that is not one or of a body past `limit`. */
export async function readBody(
  c: Context,
  limit: number,
  tooLarge: string,
): Promise<Uint8Array | Response> {
  const length = lengthOf(c, limit, tooLarge);
  if (length instanceof Response) {
    return length;
  }
  let read: BoundedBody;
  try {
    read = await readBoundedBody(c.req.raw.body, {
      limit: length.most,
      stallMs: BODY_STALL_MS,
      budgetMs: BODY_BUDGET_MS,
    });
  } catch {
    return fail(c, 'invalid_request', 'the body did not arrive whole');
  }
  if (read.kind === 'over-limit') {
    releaseStream(read.body, 'body past its limit');
    return length.most < limit
      ? fail(c, 'invalid_request', 'the body is longer than its content-length')
      : fail(c, 'too_large', tooLarge);
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
  if (body.byteLength > MAX_JSON_VALUES && !jsonValuesWithin(body, MAX_JSON_VALUES)) {
    return fail(c, 'invalid_request', `a JSON body may hold at most ${MAX_JSON_VALUES} values`);
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
