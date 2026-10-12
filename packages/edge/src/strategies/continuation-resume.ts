import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  ORIGINAL_URL_HEADER,
  pathHeaders,
  RESUME_PRERENDER_ESCAPED_HEADER,
  RESUME_PRERENDER_HEADER,
  RESUME_STATE_BODY,
  RESUME_STATE_HEADER,
  RESUME_STATE_LENGTH_HEADER,
} from '@stayingupwind/core/paas';
import { NEXT_RESUME_HEADER } from '@stayingupwind/core/request';
import type { ContinuationHandle, ContinuationStart } from '@stayingupwind/host/delivery';

import { buildResumeRequest } from '../forwarding.ts';
import { fetchUpstream } from '../handlers/upstream.ts';
import type { EdgeContext } from './context.ts';

function setAll(headers: Headers, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    headers.set(name, value);
  }
}

/**
 * Resume: ask the application's own Worker for what the shell left out.
 *
 * The shell came out of the build together with the state that says where rendering stopped, and
 * the Worker holds that state under the prerender's id. So the request names the prerender, and
 * what comes back is the suffix alone — no prefix to compare, no document to discard the head of.
 * There is no deployment to pin and nothing to retry against: the Worker is the deployment.
 *
 * A shell the runtime cache regenerated has state of its own, which the Worker does not hold:
 * the edge read it with the shell and sends it as the request body, with its length declared and
 * the route the state was rendered for named beside it, and the Worker resumes from that. Either
 * way the request keeps the pathname being served, not the route's: a class shell
 * (`/en/[orgSlug]`) resumes for the member asked for (`/en/acme`), whose parameters the runtime
 * reads off the path.
 */

class MissingPrerenderError extends Error {
  constructor(pathname: string, options?: ErrorOptions) {
    super(`route ${pathname} names no prerender to resume`, options);
    this.name = 'MissingPrerenderError';
  }
}

const OCTET_STREAM = 'application/octet-stream';

function resumeRequest(input: ContinuationStart<EdgeContext>, signal: AbortSignal): Request {
  const { entry, ctx, resume } = input;
  if (entry.prerenderId === undefined && resume?.kind !== 'runtime') {
    throw new MissingPrerenderError(entry.pathname);
  }
  const base = buildResumeRequest(
    { clientRequest: input.request, ctx: ctx.forwarding, signal },
    ctx.host.credentials,
  );
  const upstream =
    resume?.kind === 'runtime'
      ? new Request(base, { method: 'POST', body: resume.state as BodyInit })
      : base;
  // After the forwarding headers are built: what a client sends of the edge's own protocol —
  // `next-resume` among it — is stripped from them (`sanitizeContinuationHeaders`), and these are
  // the edge's to set.
  upstream.headers.set(NEXT_RESUME_HEADER, '1');
  if (resume?.kind === 'runtime') {
    upstream.headers.set(RESUME_STATE_HEADER, RESUME_STATE_BODY);
    upstream.headers.set(RESUME_STATE_LENGTH_HEADER, String(resume.state.byteLength));
    setAll(
      upstream.headers,
      pathHeaders(CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER, resume.route),
    );
    upstream.headers.set('content-type', OCTET_STREAM);
  } else if (entry.prerenderId !== undefined) {
    setAll(
      upstream.headers,
      pathHeaders(RESUME_PRERENDER_HEADER, RESUME_PRERENDER_ESCAPED_HEADER, entry.prerenderId),
    );
  }
  if (ctx.originalUrl !== undefined) {
    upstream.headers.set(ORIGINAL_URL_HEADER, ctx.originalUrl);
  }
  if (input.headers !== undefined) {
    const told = Object.entries(input.headers);
    for (const [name, value] of told) {
      upstream.headers.set(name, value);
    }
  }
  return upstream;
}

export const resumeContinuation = {
  /**
   * Ask the deployment's Worker for what the shell left out. There is no deployment to pin and
   * nothing to retry against: the Worker is the deployment.
   */
  start(input: ContinuationStart<EdgeContext>): ContinuationHandle {
    const controller = new AbortController();
    const upstream = resumeRequest(input, controller.signal);
    return {
      // The Worker the shell's route is in, for a deployment split across several.
      response: fetchUpstream(input.ctx.runtime, input.ctx.app, upstream, input.entry.function),
      abort: (reason) => {
        controller.abort(reason);
      },
    };
  },
};
