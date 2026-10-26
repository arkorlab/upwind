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

const MAX_DESCRIBED_ISSUES = 32;
const MAX_DIAGNOSTIC_LENGTH = 8192;

/** Bounded rendering, including paths and messages, before building a 400 response. */
export function describeIssues(error: ParseFailure): string {
  let description = '';
  const append = (part: string): void => {
    description += part.slice(0, MAX_DIAGNOSTIC_LENGTH - description.length);
  };
  for (const [index, issue] of error.issues.entries()) {
    if (index >= MAX_DESCRIBED_ISSUES || description.length >= MAX_DIAGNOSTIC_LENGTH) break;
    if (index > 0) append('; ');
    if (issue.path.length === 0) append('(root)');
    for (const [partIndex, part] of issue.path.entries()) {
      if (description.length >= MAX_DIAGNOSTIC_LENGTH) break;
      if (partIndex > 0) append('.');
      append(String(part));
    }
    append(': ');
    append(issue.message);
  }
  return description;
}
