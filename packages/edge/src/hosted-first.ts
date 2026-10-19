import { classifyImageRequest } from '@stayingupwind/core/images';
import type { AppRuntime, ProjectManifest } from '@stayingupwind/core/manifest';
import { classifyStaticFile } from '@stayingupwind/core/request';

import { routeHostedImage } from './handlers/hosted-image.ts';
import { routeHostedStaticFile } from './handlers/hosted-static-file.ts';
import type { MiddlewareOutcome } from './handlers/middleware.ts';
import type { PassthroughWait } from './handlers/passthrough.ts';
import type { EdgeContext, StaticFileContext } from './strategies/context.ts';

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
  readonly edge: (manifest: ProjectManifest) => StaticFileContext;
  /** Read the settings only for an image or matching middleware. */
  readonly policyReady: (manifest: ProjectManifest) => EdgeContext | Promise<EdgeContext>;
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    waited?: PassthroughWait,
  ) => Promise<Response>;
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
      policyReady: () => input.policyReady(manifest),
      manifest,
      file: file.file,
      passthrough: input.passthrough,
    });
  }
  const image = classifyImageRequest({ method: request.method, url, manifest });
  if (image !== undefined) {
    const serve = (edge: EdgeContext): Promise<Response> => {
      return routeHostedImage({
        request,
        url,
        edge,
        manifest,
        config: image.images,
        passthrough: input.passthrough,
      });
    };
    const edge = input.policyReady(manifest);
    return edge instanceof Promise ? imageAfterPolicy(edge, serve) : serve(edge);
  }
  return undefined;
}

async function imageAfterPolicy(
  edge: Promise<EdgeContext>,
  serve: (ready: EdgeContext) => Promise<Response>,
): Promise<Response> {
  return serve(await edge);
}
