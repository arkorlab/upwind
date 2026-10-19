import type { ArtifactLocator, ShellEncodings } from '@stayingupwind/core/artifact';
import type { ProjectManifest, RouteSegment } from '@stayingupwind/core/manifest';
import { NULL_BODY_STATUSES } from '@stayingupwind/core/request';

const MIN_RESPONSE_STATUS = 200;
const MAX_RESPONSE_STATUS = 599;

/** Test only transport validity, retaining every value the runtime's Headers accepts. */
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
    !Number.isInteger(status) ||
    status < MIN_RESPONSE_STATUS ||
    status > MAX_RESPONSE_STATUS ||
    NULL_BODY_STATUSES.has(status)
  ) {
    throw new TypeError('the stored file status cannot carry its body');
  }
}

/** Cold decode only: a digest authenticates bytes, not their safety as response headers. */
export function checkManifestContentTypes(manifest: ProjectManifest): void {
  const check = headerCheck();
  for (const route of Object.values(manifest.routes)) {
    check(route.shell);
    checkEncodings(check, route.shellEncodings);
    if (route.segments !== undefined) {
      for (const part of Object.values(route.segments)) checkPart(check, part);
    }
    checkPart(check, route.payload);
    checkPart(check, route.pagesData);
  }
  for (const file of Object.values(manifest.staticFiles ?? {})) {
    checkFileStatus(file.status);
    check(file);
    check(file.previous);
  }
}
