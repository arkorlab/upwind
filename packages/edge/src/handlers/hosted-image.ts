import { type ImagesConfig, parseImageRequest } from '@stayingupwind/core/images';
import { headerRulesFor } from '@stayingupwind/core/manifest';
import { PatternBudgetExceededError } from '@stayingupwind/core/request';

import { type HostedGateInput, serveAfterMiddleware } from './hosted-gate.ts';
import { handleImage, imageErrorResponse } from './image.ts';
import { PATTERN_BUDGET } from './passthrough.ts';

export interface HostedImageInput extends HostedGateInput {
  readonly config: ImagesConfig;
}

const HTTP_BAD_REQUEST = 400;
/** The optimizer's words for a source the configuration does not allow. */
const NOT_ALLOWED = '"url" parameter is not allowed';

/**
 * Where one of the application's patterns costs more against the request than the edge runs
 * (`budgetPatterns`) — a source's against the configuration's, a rule's, a matcher's — the request
 * is refused as one the configuration does not allow. Not handed to the application's Worker, as a
 * document is: no Worker of the application optimizes an image, and it would answer with a 404.
 */
function refused(): Promise<Response> {
  return Promise.resolve(
    imageErrorResponse(
      { status: HTTP_BAD_REQUEST, message: NOT_ALLOWED, requests: 0 },
      PATTERN_BUDGET,
    ),
  );
}

/**
 * `/_next/image` of a hosted application: what Next.js runs ahead of its optimizer — the rules
 * of `next.config` that claim the path, the middleware — has its say first, on every request
 * alike; then the parameters are checked as the optimizer checks them, and a request that names
 * something the configuration does not allow is refused in the optimizer's words.
 */
export async function routeHostedImage(input: HostedImageInput): Promise<Response> {
  try {
    return await routeWithinBudget(input);
  } catch (error) {
    if (error instanceof PatternBudgetExceededError) {
      return refused();
    }
    throw error;
  }
}

function routeWithinBudget(input: HostedImageInput): Promise<Response> {
  const { url, edge, manifest, config } = input;
  return serveAfterMiddleware(input, {
    overBudget: refused,
    serve: (middleware, dispatches) => {
      // As the middleware left it: an `accept` it overrode decides the format, a conditional it
      // removed is gone.
      const request =
        middleware === undefined
          ? input.request
          : new Request(input.request, { headers: middleware.requestHeaders });
      const parsed = parseImageRequest(url.searchParams, request.headers.get('accept'), config);
      if (parsed.kind === 'invalid') {
        return Promise.resolve(
          imageErrorResponse(
            { status: HTTP_BAD_REQUEST, message: parsed.errorMessage, requests: 0 },
            'image-invalid',
          ),
        );
      }
      return handleImage({
        request,
        edge,
        manifest,
        config,
        params: parsed.params,
        configured: headerRulesFor(manifest, url, input.request.headers),
        middleware,
        middlewareDispatches: dispatches,
      });
    },
  });
}
