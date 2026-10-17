import { PRIMARY_FUNCTION } from '@stayingupwind/core/bundle';
import {
  type AppRuntime,
  functionFor,
  functionScript,
  type ProjectManifest,
} from '@stayingupwind/core/manifest';
import { FUNCTION_HEADER, MISDIRECTED_STATUS, ROUTED_HEADER } from '@stayingupwind/core/paas';
import { PatternBudgetExceededError } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import { withScopeRevision } from '../cache/scope-signal.ts';
import type { DispatchApp, EdgeRuntime } from '../edge-runtime.ts';

/**
 * Where a request the edge does not answer itself goes: the deployment's own Worker, reached by
 * name however the host reaches its Functions (`EdgeRuntime.dispatchApp`).
 *
 * The only host the edge knows for a project is the one the request arrived on, and that is this
 * very Worker — so a request with no Worker to dispatch to has nowhere to go, and saying so is
 * the answer. `routeRequest` refuses such a project (`notDeployed`) before anything reaches here;
 * this is the guard for a caller that does not.
 */
class NoApplicationError extends Error {
  constructor() {
    super('the deployment names no application Worker');
    this.name = 'NoApplicationError';
  }
}

class NoDispatchError extends Error {
  constructor() {
    super('the runtime gives the edge no dispatchApp');
    this.name = 'NoDispatchError';
  }
}

/** Where a request to a deployment split across app Workers went, and whether it was sent on. */
export interface Dispatched {
  /** The bundle's name for the Worker that answered (`app`, `app-2`, …), or that failed to. */
  readonly fn: string;
  /** The Worker asked first: `fn`, unless that one named another. */
  readonly asked: string;
  /** The Worker first asked answered that the route is another's, and that one answered. */
  readonly redispatched: boolean;
}

const DISPATCHED = new WeakMap<Response, Dispatched>();

/** A split deployment's request: the Worker it is meant for, and the Worker it was last sent to. */
interface Progress {
  readonly fn: string;
  dispatched: Dispatched | undefined;
}

/** The same, however the request ended or before it has, by what `fetchUpstream` handed back. */
const UNDER_WAY = new WeakMap<Promise<Response>, Progress>();

/** How far a split deployment's request had got where the Worker it was sent on to failed. */
const FAILED = new WeakMap<Error, Dispatched>();

/** What `fetchUpstream` handed back without sending anything, there being nowhere to send it. */
const UNSENT = new WeakSet<Promise<Response>>();

function unsent(reason: Error): Promise<Response> {
  const refused = Promise.reject(reason);
  UNSENT.add(refused);
  return refused;
}

/**
 * Where the answer of a split deployment came from (`fetchUpstream`); `undefined` for any other
 * answer — a deployment that was not split records nothing, and pays nothing to.
 */
export function dispatchedOf(response: Response): Dispatched | undefined {
  return DISPATCHED.get(response);
}

/** The dispatches an answer took: one, and one more where the Worker first asked named another. */
export function dispatchesOf(response: Response): number {
  return DISPATCHED.get(response)?.redispatched === true ? 2 : 1;
}

/**
 * Which app Worker a request goes to, for a deployment whose build split its routes across several:
 * the one the manifest's tables place the route in, read the way Next.js routes it (`functionFor`)
 * — and `undefined`, the first, where they cannot say, or where the deployment was not split. Read
 * off the request as the Worker will be handed it: after the middleware, when the edge ran it. A
 * wrong answer costs one more hop, never a different response (`fetchUpstream`).
 */
export function functionOfRequest(
  app: AppRuntime | undefined,
  manifest: ProjectManifest | undefined,
  request: Request,
): string | undefined {
  if (manifest === undefined || app?.functions === undefined) {
    return undefined;
  }
  try {
    return functionFor(manifest, new URL(request.url), request.headers);
  } catch (error) {
    // A pattern of the application's the edge does not run against this request
    // (`budgetPatterns`): the tables cannot say, and the first Worker hands it to the right one.
    if (error instanceof PatternBudgetExceededError) {
      return undefined;
    }
    throw error;
  }
}

/** The Worker a misdirected answer names; `undefined` for any other answer. */
function misdirectedTo(response: Response): string | undefined {
  if (response.status !== MISDIRECTED_STATUS) {
    return undefined;
  }
  // The runtime takes this header off every answer of the application's own, so a 421 without it
  // is the application's, and goes to the client as any other answer does.
  return response.headers.get(FUNCTION_HEADER) ?? undefined;
}

/**
 * The request again, for the Worker the first one named: the routing that one already did, and the
 * body it handed back unread — the request's own, which it never consumed.
 */
function sentOn(request: Request, misdirected: Response): Request | undefined {
  // Whether there is a body to send on is the request's to say: one that came without is sent on
  // without, whatever the Worker answered with.
  const hasBody = request.body !== null;
  // A request that had a body, answered with none: it went nowhere the edge can send it on from.
  if (hasBody && misdirected.body === null) {
    return undefined;
  }
  const headers = new Headers(request.headers);
  const routed = misdirected.headers.get(ROUTED_HEADER);
  if (routed === null) {
    headers.delete(ROUTED_HEADER);
  } else {
    headers.set(ROUTED_HEADER, routed);
  }
  if (!hasBody) {
    releaseStream(misdirected.body, 'misdirected answer to a request with no body');
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    redirect: request.redirect,
    signal: request.signal,
    ...(hasBody && { body: misdirected.body, duplex: 'half' }),
  });
}

/**
 * The app Workers of a split deployment disagree about whose route a request is: one named a Worker
 * the deployment does not run, or the one it named named another — or one handed back no body for a
 * request that had one. Nothing the edge can send on, and a failure to reach the application like
 * any other, for whoever asked to say so its own way; `dispatched` says how far it got.
 */
export class MisroutedError extends Error {
  readonly dispatched: Dispatched;

  constructor(detail: string, options: ErrorOptions & { readonly dispatched: Dispatched }) {
    super(`misrouted between app Workers: ${detail}`, options);
    this.name = 'MisroutedError';
    this.dispatched = options.dispatched;
  }
}

function misrouted(response: Response, detail: string, dispatched: Dispatched): never {
  releaseStream(response.body, 'misrouted between app Workers');
  throw new MisroutedError(detail, { dispatched });
}

/**
 * How far a split deployment's request has got (`fetchUpstream`, by the promise it handed back):
 * the Worker it was last sent to, and whether that was the second. Read the same whether the
 * request was answered, failed, or is still out — a caller that stopped waiting for it
 * (`withDeadline`, a first-byte timeout) has neither an answer nor an error of its own to ask.
 * `undefined` for any other request: a deployment that was not split records nothing.
 */
export function dispatchedSoFar(answer: Promise<Response>): Dispatched | undefined {
  return UNDER_WAY.get(answer)?.dispatched;
}

/** The dispatches a request has taken so far, counted as `dispatchesOf` counts an answer's. */
export function dispatchesSoFar(answer: Promise<Response>): number {
  return dispatchedSoFar(answer)?.redispatched === true ? 2 : 1;
}

/**
 * The dispatches a request had made when it was let go, as `dispatchesSoFar` counts them: none where
 * `fetchUpstream` had nowhere to send it, since nothing went out.
 */
export function dispatchesMade(answer: Promise<Response>): number {
  return UNSENT.has(answer) ? 0 : dispatchesSoFar(answer);
}

/**
 * The dispatches a request that failed had taken, by what it failed with, for a caller that has
 * the error and not the request (`fetchUpstream`), counted as `dispatchesOf` counts an answer's:
 * two where the Worker first asked named another, and the one it was sent on to failed or named
 * another again (`MisroutedError`).
 */
export function dispatchesOfFailure(error: unknown): number {
  if (!(error instanceof Error)) {
    return 1;
  }
  const dispatched = error instanceof MisroutedError ? error.dispatched : FAILED.get(error);
  return dispatched?.redispatched === true ? 2 : 1;
}

/**
 * A request to a deployment split across app Workers: to the Worker `progress.fn` names — the
 * first, for a name the deployment does not run — and on to the one that Worker names, once, where
 * it answers that the route is another's (`MISDIRECTED_STATUS`). The second Worker answers from
 * where the first one's routing left off, so the middleware runs once and the answer is the one a
 * single Worker would have given. A second such answer is never followed: the two Workers
 * disagreeing about whose route it is would otherwise send the request round between them.
 * `progress` is told of each Worker before it is asked (`dispatchedSoFar`).
 */
async function dispatchSplit(
  dispatch: DispatchApp,
  app: AppRuntime,
  request: Request,
  progress: Progress,
): Promise<Response> {
  const { fn } = progress;
  const asked = functionScript(app, fn) === undefined ? PRIMARY_FUNCTION : fn;
  const first: Dispatched = { fn: asked, asked, redispatched: false };
  progress.dispatched = first;
  const response = await dispatch(functionScript(app, asked) ?? app.scriptName, request);
  const owner = misdirectedTo(response);
  if (owner === undefined) {
    DISPATCHED.set(response, first);
    return response;
  }
  // The first Worker among them: `functionScript` names it by `scriptName`, so a Worker after the
  // first that names it is followed as any other is.
  const script = functionScript(app, owner);
  if (script === undefined || owner === asked) {
    misrouted(response, `${asked} named ${owner}`, first);
  }
  const again = sentOn(request, response);
  if (again === undefined) {
    misrouted(response, `${asked} handed back no body for ${owner}`, first);
  }
  const dispatched: Dispatched = { fn: owner, asked, redispatched: true };
  progress.dispatched = dispatched;
  let answered: Response;
  try {
    answered = await dispatch(script, again);
  } catch (error) {
    // Said of the error too, for a caller that has it and not the request (`dispatchesOfFailure`).
    if (error instanceof Error) {
      FAILED.set(error, dispatched);
    }
    throw error;
  }
  const named = misdirectedTo(answered);
  if (named !== undefined) {
    misrouted(answered, `${owner} named ${named} after ${asked} named it`, dispatched);
  }
  DISPATCHED.set(answered, dispatched);
  return answered;
}

/**
 * Send a request to the deployment's app Worker: `fn` names which, for a deployment split across
 * several, and the first is meant without it. A deployment that was not split is one property
 * read away from what it always was.
 */
export function fetchUpstream(
  runtime: EdgeRuntime,
  app: AppRuntime | undefined,
  request: Request,
  fn?: string,
): Promise<Response> {
  if (app === undefined) {
    return unsent(new NoApplicationError());
  }
  if (runtime.dispatchApp === undefined) {
    return unsent(new NoDispatchError());
  }
  // Told where the deployment's scope stands, as this isolate last found it: a Function behind it
  // catches up before it judges anything (`SCOPE_REVISION_HEADER`). A deployment's scope is its id.
  const told = withScopeRevision(runtime, app.deploymentId, request);
  if (app.functions === undefined) {
    return runtime.dispatchApp(app.scriptName, told);
  }
  const progress: Progress = { fn: fn ?? PRIMARY_FUNCTION, dispatched: undefined };
  const answer = dispatchSplit(runtime.dispatchApp, app, told, progress);
  UNDER_WAY.set(answer, progress);
  return answer;
}
