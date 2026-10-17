import type { GatewayError, GatewayErrorCode } from '@stayingupwind/host/cache';
import type { ParseFailure } from '@stayingupwind/host/util';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { isRefusal } from '../scope/state.ts';

/** The gateway's answers: one envelope, and the status each refusal maps to. */

export const HTTP = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, ContentfulStatusCode>;

const STATUS_OF: Record<GatewayErrorCode, ContentfulStatusCode> = {
  unauthorized: HTTP.UNAUTHORIZED,
  scope_retired: HTTP.GONE,
  invalid_request: HTTP.BAD_REQUEST,
  not_found: HTTP.NOT_FOUND,
  superseded: HTTP.CONFLICT,
  lease_expired: HTTP.CONFLICT,
  stale_dependencies: HTTP.CONFLICT,
  quota_exceeded: HTTP.TOO_MANY_REQUESTS,
  artifact_missing: HTTP.UNPROCESSABLE,
  artifact_mismatch: HTTP.UNPROCESSABLE,
  too_large: HTTP.PAYLOAD_TOO_LARGE,
  internal: HTTP.INTERNAL_ERROR,
};

export function fail(c: Context, code: GatewayErrorCode, message: string): Response {
  const body: GatewayError = { ok: false, error: { code, message } };
  return c.json(body, STATUS_OF[code]);
}

export function ok(c: Context, result: unknown): Response {
  return c.json({ ok: true as const, result });
}

/** What the authority answered, as the envelope: a refusal is an error, anything else a result. */
export function answer(c: Context, result: unknown): Response {
  return isRefusal(result) ? fail(c, result.code, result.message) : ok(c, result);
}

/** Compact, non-sensitive rendering of a schema's issues for 400 responses. */
export function describeIssues(error: ParseFailure): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
