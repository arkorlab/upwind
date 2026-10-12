import { classifyImageRequest } from '@stayingupwind/core/images';
import type { AppRuntime, ProjectManifest } from '@stayingupwind/core/manifest';
import { classifyStaticFile } from '@stayingupwind/core/request';

import { routeHostedImage } from './handlers/hosted-image.ts';
import { routeHostedStaticFile } from './handlers/hosted-static-file.ts';
import type { MiddlewareOutcome } from './handlers/middleware.ts';
import type { EdgeContext } from './strategies/context.ts';

/**
 * What a hosted application is answered before the pointer's mode is looked at.
 *
 * A file the build shipped, and an optimized image, are the same to every visitor whatever the
 * pointer says about shells — a suspect or demoted route, a disabled site, a passthrough demotion
 * are all about documents — and the application's Worker cannot answer either: it does not carry
 * its `_next/` files, and it has no image optimizer. An application whose scripts, styles and
 * images cannot load is not being proxied transparently.
 */

export interface HostedFirstInput {
  readonly request: Request;
  readonly url: URL;
  readonly app: AppRuntime | undefined;
  readonly manifest: ProjectManifest | undefined;
  /** The context a handler runs under, built only when one is going to. */
  readonly edge: (manifest: ProjectManifest) => EdgeContext;
  readonly passthrough: (reason: string, middleware?: MiddlewareOutcome) => Promise<Response>;
}

const STATIC_FILE_CLASS = 'static-file';

export function hostedFirst(input: HostedFirstInput): Promise<Response> | undefined {
  const { request, url, manifest } = input;
  if (manifest === undefined || input.app === undefined) {
    return undefined;
  }
  const file = classifyStaticFile({
    method: request.method,
    url,
    manifest,
    deployment: manifest.deployment,
  });
  if (file?.kind === STATIC_FILE_CLASS) {
    return routeHostedStaticFile({
      request,
      url,
      edge: input.edge(manifest),
      manifest,
      file: file.file,
      passthrough: input.passthrough,
    });
  }
  const image = classifyImageRequest({ method: request.method, url, manifest });
  if (image !== undefined) {
    return routeHostedImage({
      request,
      url,
      edge: input.edge(manifest),
      manifest,
      config: image.images,
      passthrough: input.passthrough,
    });
  }
  return undefined;
}
