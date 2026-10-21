import { sha256HexOfText } from '@stayingupwind/core/artifact';
import { NULL_BODY_STATUSES } from '@stayingupwind/core/request';

import type { ImageSource } from './image-source.ts';

/** The statuses Fetch calls ok: the only ones Next.js's optimizer takes a source of its own under. */
const FIRST_OK_STATUS = 200;
const LAST_OK_STATUS = 299;

/**
 * Whether a shipped file is a source under the status the middleware gave the rewrite that led to
 * it (`rewriteStatus`). The file answers under that status, as a request for it is answered
 * (`underRewriteStatus`, in `hosted-static-file.ts`), and Next.js's optimizer takes a source only
 * from an answer that is ok and carries a body (`fetchInternalImage`), as `fetchLocal` takes the
 * Worker's.
 */
export function sourceUnder(status: number | undefined): boolean {
  return (
    status === undefined ||
    (status >= FIRST_OK_STATUS && status <= LAST_OK_STATUS && !NULL_BODY_STATUSES.has(status))
  );
}

/** The usual identifiers keep their bytes; URL syntax cannot consume a component of the key. */
const UNESCAPED_IMAGE_PART = /^[\w.~-]*$/u;

function imagePathPart(value: string): string {
  // JSON first preserves every UTF-16 string, including lone surrogates URI encoding refuses.
  return UNESCAPED_IMAGE_PART.test(value)
    ? value
    : encodeURIComponent(JSON.stringify(value).slice(1, -1));
}

/**
 * What one optimized image is cached under: the source's identity, then the parameters. A shipped
 * file is its hash, shared across deployments and invalidated by a change to the file — unless a
 * gate stands on its path, when the result is this deployment's answer for that path on the host
 * the request came in on, as another pathname of the application is bound to the deployment and
 * the host and project that answered it: a hostname may move between projects whose deployment
 * identifiers coincide, and each application's answer stays its own; a
 * URL is itself. A gated file still names its selected bytes in that answer: middleware can let
 * either this build's file or the previous build's through at the same path (Greptile), and those
 * must not share the result. The hash goes into the same digest as the path, with no extra read.
 */
interface ImageIdentity {
  readonly projectId: string;
  readonly app?: { readonly deploymentId: string } | undefined;
  readonly forwarding: { readonly previewHost: string };
}

export async function imageSourceId(source: ImageSource, identity: ImageIdentity): Promise<string> {
  const { projectId, app, forwarding } = identity;
  const answered = async (href: string): Promise<string> =>
    `local:${imagePathPart(projectId)}:${imagePathPart(app?.deploymentId ?? '')}:${imagePathPart(forwarding.previewHost)}:${await sha256HexOfText(href)}`;
  switch (source.kind) {
    case 'blob': {
      const blob = sourceUnder(source.file.status)
        ? source.file.sha256
        : `refused:${source.file.status}:${source.file.sha256}`;
      return source.gate === 'none' ? `blob:${blob}` : answered(`blob:${blob}:${source.href}`);
    }
    case 'local': {
      return answered(source.href);
    }
    case 'remote': {
      return `remote:${await sha256HexOfText(source.href)}`;
    }
  }
}
