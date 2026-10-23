import type { ArtifactLocator, ShellEncodings } from '@stayingupwind/core/artifact';
import type { ProjectManifest, RouteSegment } from '@stayingupwind/core/manifest';
import { filterShellResponseHeaders, NULL_BODY_STATUSES } from '@stayingupwind/core/request';

import { retainSafePreloads } from './manifest-preloads.ts';

const MIN_RESPONSE_STATUS = 200;
const MAX_RESPONSE_STATUS = 599;
const INVALID_RESPONSE_VALUE = /[\0\r\n]/u;

function httpWhitespace(character: string | undefined): boolean {
  return character !== undefined && '\t\r\n '.includes(character);
}

/** Match Workers' edge trim with bounded scans, without copying or backtracking. */
function invalidAfterHttpWhitespace(value: string): boolean {
  let start = 0;
  let end = value.length;
  while (start < end && httpWhitespace(value[start])) start += 1;
  while (end > start && httpWhitespace(value[end - 1])) end -= 1;
  for (let at = start; at < end; at += 1) {
    const character = value[at];
    if (character !== undefined && '\0\r\n'.includes(character)) return true;
  }
  return false;
}

/** Workers permits Unicode; repeated stored values need only one cold transport check. */
function responseValueCheck(): (value: string | undefined) => void {
  const checked = new Set<string>();
  return (value) => {
    if (value === undefined || checked.has(value)) return;
    if (INVALID_RESPONSE_VALUE.test(value) && invalidAfterHttpWhitespace(value)) {
      throw new TypeError('the stored response header value cannot be sent');
    }
    checked.add(value);
  };
}

/** Check transport validity, allowing the same HTTP whitespace normalization as Headers.set. */
function headerCheck(): (artifact: Pick<ArtifactLocator, 'contentType'> | undefined) => void {
  const headers = new Headers();
  const checked = new Set<string>();
  return (artifact) => {
    if (artifact === undefined || checked.has(artifact.contentType)) return;
    headers.set('content-type', artifact.contentType);
    checked.add(artifact.contentType);
  };
}

type Check = ReturnType<typeof headerCheck>;

function checkEncodings(check: Check, encodings: ShellEncodings | undefined): void {
  check(encodings?.br);
  check(encodings?.gzip);
}

function checkPart(check: Check, part: RouteSegment | undefined): void {
  if (part === undefined) return;
  check(part.artifact);
  checkEncodings(check, part.encodings);
}

/** A stored file carries bytes; reject statuses the response constructor cannot carry them under. */
function checkFileStatus(status: number | undefined): void {
  if (status === undefined) return;
  if (
    !Number.isSafeInteger(status) ||
    status < MIN_RESPONSE_STATUS ||
    status > MAX_RESPONSE_STATUS ||
    NULL_BODY_STATUSES.has(status)
  ) {
    throw new TypeError('the stored file status cannot carry its body');
  }
}

/** Vouched stored bytes can also carry null, which the prior empty fallback skipped. */
function checkFiles(check: Check, files: ProjectManifest['staticFiles'] | null): void {
  if (files === null || files === undefined) return;
  for (const file of Object.values(files)) {
    checkFileStatus(file.status);
    check(file);
    check(file.previous);
  }
}

/** Cold decode only: a digest authenticates bytes, not their safety as response headers. */
export function checkManifestContentTypes(manifest: ProjectManifest): void {
  const check = headerCheck();
  const checkResponse = responseValueCheck();
  checkResponse(manifest.images?.contentSecurityPolicy);
  for (const route of Object.values(manifest.routes)) {
    const headers = filterShellResponseHeaders(Object.entries(route.headers));
    for (const value of Object.values(headers)) checkResponse(value);
    check(route.shell);
    checkEncodings(check, route.shellEncodings);
    if (route.segments !== undefined) {
      for (const part of Object.values(route.segments)) checkPart(check, part);
    }
    checkPart(check, route.payload);
    checkPart(check, route.pagesData);
    retainSafePreloads(route);
  }
  checkFiles(check, manifest.staticFiles);
}
