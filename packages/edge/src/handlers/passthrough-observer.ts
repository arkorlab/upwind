import { releaseStream } from '@stayingupwind/core/util';

import { logWarn } from '../observability/logger.ts';
import type { PreviewState } from '../preview/state.ts';
import type { IncomingRequest } from '../request-context.ts';
import type { StaticFileContext } from '../strategies/context.ts';

/**
 * The host's observer of a request the edge hands on (`RoutingInput.observePassthrough`): what it
 * is shown of the request, a copy of its body to read where it wants one, and what it is told once
 * the answer is in. It is the host's own code, and nothing it does or throws changes the answer.
 */

/** The site a passthrough's observer is shown: its state, with the policy as files are served. */
export type ObservedState = Omit<PreviewState, 'policy'> & {
  readonly policy: StaticFileContext['policy'];
};

/**
 * A copy of the request's body for the host's observer of a passthrough to read, `null` for a
 * request with none: the body is split as it is first asked for, the edge keeping the branch it
 * forwards (`PassthroughInput.observedBody`), and asked again, it hands out the same copy. Whatever
 * the observer does with its copy, or throws once it holds it, the request is forwarded whole.
 */
export type CopyRequestBody = () => ReadableStream<Uint8Array> | null;

/**
 * A host's view of one passthrough: what it is told once the answer is in — the answer itself, or
 * nothing where forwarding failed.
 */
export interface PassthroughObservation {
  readonly finish: (response?: Response) => void;
}

/**
 * What the host observes of a request the edge hands on, where it observes it. Asked of every
 * passthrough, so it answers `undefined` at once for one it leaves alone.
 */
export type ObservePassthrough = (
  request: IncomingRequest,
  url: URL,
  state: ObservedState,
  copyBody: CopyRequestBody,
) => PassthroughObservation | undefined;

/** What `observationOf` reads of a routing input. */
interface ObservedInput {
  readonly request: IncomingRequest;
  readonly url: URL;
  readonly state: ObservedState;
  readonly observePassthrough?: ObservePassthrough | undefined;
}

/** What an observed passthrough forwards, and whom it tells what came of it. */
export interface Observed {
  /** The branch of the body forwarded, where the observer asked for a copy. */
  readonly forwarded: ReadableStream<Uint8Array> | undefined;
  /** Told once the answer is in, where the observer makes an observation. */
  readonly finish: PassthroughObservation['finish'] | undefined;
}

/**
 * Ask the host's observer of a passthrough, or tell it what came of one, so that neither touches
 * the answer: the observer is the host's own code, and what it throws is logged and goes no further.
 */
function askObserver<T>(ask: () => T): T | undefined {
  try {
    return ask();
  } catch (error) {
    logWarn('the host observer threw', {
      told: 'passthrough',
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The host's observation of a passthrough, where it makes one (`askObserver`). One that throws
 * observes nothing, and the request is handed on as one it left alone — its body the branch the
 * edge kept, where the observer had asked for a copy, and the copy let go of: a copy nobody reads
 * would hold the whole body for its branch as the other is forwarded.
 */
export function observationOf(input: ObservedInput): Observed | undefined {
  const observe = input.observePassthrough;
  if (observe === undefined) {
    return undefined;
  }
  const split: { forwarded?: ReadableStream<Uint8Array>; copy?: ReadableStream<Uint8Array> } = {};
  const copyBody: CopyRequestBody = () => {
    if (split.copy === undefined) {
      const { body } = input.request;
      if (body === null) {
        return null;
      }
      // `tee()` is typed as the runtime declares the body, which is `any` either side of it.
      const [forwarded, copy] = body.tee() as [
        ReadableStream<Uint8Array>,
        ReadableStream<Uint8Array>,
      ];
      split.forwarded = forwarded;
      split.copy = copy;
    }
    return split.copy;
  };
  const observed = askObserver(() => observe(input.request, input.url, input.state, copyBody));
  if (observed === undefined) {
    releaseStream(split.copy, 'the passthrough was not observed');
    return split.forwarded === undefined
      ? undefined
      : { forwarded: split.forwarded, finish: undefined };
  }
  return { forwarded: split.forwarded, finish: observed.finish };
}

/** The answer to an observed passthrough, its observer told as it comes, or that none came. */
export async function finishObserved(
  pending: Promise<Response>,
  finish: PassthroughObservation['finish'],
): Promise<Response> {
  let response: Response;
  try {
    response = await pending;
  } catch (error) {
    askObserver(() => {
      finish();
    });
    throw error;
  }
  askObserver(() => {
    finish(response);
  });
  return response;
}
