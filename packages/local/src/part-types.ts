import type { ConfiguredHeaders } from '@stayingupwind/core/manifest';
import { RSC_CONTENT_TYPE } from '@stayingupwind/core/request';

import type { Part } from './part-marks.ts';
import type { Reading } from './reading.ts';

/** Runtime Pages props use UTF-8 JSON where the build commonly records the bare media type. */
const JSON_UTF8 = /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu;

function jsonUtf8(type: string | undefined): boolean {
  return type !== undefined && JSON_UTF8.test(type);
}

/** Keep explicit rules, build representations and non-JSON parts exact. */
export function partTypeFailure(
  part: Part,
  answer: Reading,
  configured: ConfiguredHeaders,
  runtime: boolean,
): string | undefined {
  const written = part.built?.contentType ?? RSC_CONTENT_TYPE;
  const expected = part.kind === 'data' ? (configured.headers['content-type'] ?? written) : written;
  const type = answer.headers['content-type'];
  const compatible =
    runtime &&
    part.kind === 'data' &&
    configured.headers['content-type'] === undefined &&
    jsonUtf8(type) &&
    jsonUtf8(expected);
  return type === expected || compatible
    ? undefined
    : `answered as ${type ?? 'no type'}, not ${expected}`;
}
