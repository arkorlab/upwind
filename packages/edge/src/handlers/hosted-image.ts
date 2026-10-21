import {
  classifyImageRequest,
  type ImagesConfig,
  parseImageRequest,
} from '@stayingupwind/core/images';
import { type ConfiguredHeaders, isReserved } from '@stayingupwind/core/manifest';
import { DEPLOYMENT_ID_QUERY, PatternBudgetExceededError } from '@stayingupwind/core/request';
import { withoutHostCredentials } from '@stayingupwind/host/credentials';

import { type HostedGateInput, serveAfterMiddleware, type TimedContinue } from './hosted-gate.ts';
import { serveHostedFile } from './hosted-static-file.ts';
import { handleImage, type ImageAnswerInput, refuseImage } from './image.ts';
import {
  handedHeaders,
  headerRulesAsRouted,
  type MiddlewareOutcome,
  type MiddlewareTiming,
} from './middleware.ts';
import { PATTERN_BUDGET } from './passthrough.ts';

export interface HostedImageInput extends HostedGateInput {
  readonly config: ImagesConfig;
}

const HTTP_BAD_REQUEST = 400;
/** The optimizer's words for a source the configuration does not allow. */
const NOT_ALLOWED = '"url" parameter is not allowed';
/** What a refusal carries of the path's rules where one of them cost too much to judge. */
const UNJUDGED: ConfiguredHeaders = { headers: {}, conditioned: false };

/**
 * What an answer to the request goes out under, once the middleware had its say: the request as it
 * left it — an `accept` it overrode decides the format, a conditional it removed is gone — and the
 * path's rules, which the router selects on the request as it came.
 */
function answering(
  input: HostedImageInput,
  middleware: TimedContinue | undefined,
  dispatches: number,
  configured: ConfiguredHeaders,
): ImageAnswerInput {
  let headers = middleware?.requestHeaders ?? input.request.headers;
  const { credentials } = input.edge.host;
  if (credentials.headers.length > 0 && credentials.headers.some((name) => headers.has(name))) {
    headers = withoutHostCredentials(new Headers(headers), credentials);
  }
  // Host-owned format and conditional headers cannot select an application's image response.
  const request =
    headers === input.request.headers ? input.request : new Request(input.request, { headers });
  const { edge, config } = input;
  return {
    request,
    edge,
    config,
    configured,
    middleware,
    middlewareDispatches: dispatches,
    middlewareMs: middleware?.middlewareMs,
  };
}

/** The path's rules for a refusal: none where it is one of theirs that costs too much to judge. */
function rulesForRefusal(input: HostedImageInput): ConfiguredHeaders {
  try {
    return headerRulesAsRouted(input.edge, input.manifest, input.url, input.request.headers);
  } catch (error) {
    if (error instanceof PatternBudgetExceededError) {
      return UNJUDGED;
    }
    throw error;
  }
}

/**
 * Where one of the application's patterns costs more against the request than the edge runs
 * (`budgetPatterns`) — a source's against the configuration's, a rule's, a matcher's — the request
 * is refused as one the configuration does not allow. Not handed to the application's Worker, as a
 * document is: no Worker of the application optimizes an image, and it would answer with a 404.
 * Under what the middleware set, where it ran.
 */
function refused(
  input: HostedImageInput,
  middleware?: MiddlewareOutcome & Partial<MiddlewareTiming>,
  dispatches = 0,
  configured = rulesForRefusal(input),
): Promise<Response> {
  const continued = middleware?.kind === 'continue' ? middleware : undefined;
  const answer = answering(input, continued, dispatches, configured);
  const error = { status: HTTP_BAD_REQUEST, message: NOT_ALLOWED, requests: 0 };
  return Promise.resolve(refuseImage(answer, error, PATTERN_BUDGET));
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
      return refused(input);
    }
    throw error;
  }
}

/**
 * The optimizer's answer for the parameters `target` carries — the request's own, or those of the
 * optimizer's path a middleware rewrote it to — under the rules the request as it came selected.
 */
function optimized(
  input: HostedImageInput,
  target: URL,
  answer: ImageAnswerInput,
): Promise<Response> {
  const { manifest, config } = input;
  const parsed = parseImageRequest(
    target.searchParams,
    answer.request.headers.get('accept'),
    config,
  );
  if (parsed.kind === 'invalid') {
    const error = { status: HTTP_BAD_REQUEST, message: parsed.errorMessage, requests: 0 };
    return Promise.resolve(refuseImage(answer, error, 'image-invalid'));
  }
  return handleImage({
    ...answer,
    manifest,
    params: parsed.params,
    dpl: namedDeployment(input.url),
  });
}

/**
 * The deployment the client's request names, where it names one alone (`dpl`): Next.js's loader
 * writes the document's own onto the optimizer's URL, and a URL the middleware rewrote the request
 * to is not the document's.
 */
function namedDeployment(url: URL): string | undefined {
  const named = url.searchParams.getAll(DEPLOYMENT_ID_QUERY);
  return named.length === 1 ? named[0] : undefined;
}

function routeWithinBudget(input: HostedImageInput): Promise<Response> {
  const { request, manifest } = input;
  return serveAfterMiddleware(input, {
    overBudget: (middleware, dispatches, configured) =>
      refused(input, middleware, dispatches, configured),
    serve: (middleware, dispatches, configured) =>
      optimized(input, input.url, answering(input, middleware, dispatches, configured)),
    // A rewrite that stays on the optimizer's path — another source, width or quality — is the
    // optimizer's to answer, as Next.js's router hands it the rewritten parameters: no Worker of
    // the application has one. Elsewhere, the target's routing runs before a shipped file can
    // answer it; anything the edge cannot serve stays with the Worker.
    rewritten: (middleware, dispatches, configured) => {
      const still = classifyImageRequest({ method: request.method, url: middleware.url, manifest });
      if (still !== undefined) {
        return optimized(
          input,
          middleware.url,
          answering(input, middleware, dispatches, configured),
        );
      }
      try {
        if (
          manifest.reservedRoutes !== undefined &&
          isReserved(
            manifest,
            middleware.url,
            handedHeaders(input.edge, middleware.requestHeaders),
            true,
          )
        ) {
          return;
        }
      } catch (error) {
        if (!(error instanceof PatternBudgetExceededError)) {
          throw error;
        }
        // The rewritten target is no longer an optimizer request; its Function can route it.
        return;
      }
      return serveHostedFile({ ...input, configured }, middleware.url, middleware, dispatches);
    },
  });
}
