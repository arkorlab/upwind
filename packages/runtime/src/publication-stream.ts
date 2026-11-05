import { admitPublication, type PublicationRequirement } from '@stayingupwind/core/cache';
import { enforcePublicationPolicy, markPublicationPolicy } from '@stayingupwind/core/paas';

import { nowMs } from './cache/clock.ts';
import type { RequestContext } from './cache/context.ts';
import { livePublicationState } from './publication-state.ts';

const UNAVAILABLE = 'Publication unavailable';

function privateResponse(response: Response, body: ReadableStream<Uint8Array> | null): Response {
  const admitted = new Response(body, response);
  enforcePublicationPolicy(admitted.headers, { mode: 'no-store', noTransform: false });
  return markPublicationPolicy(admitted);
}

/** Live observations can arrive after headers; a streamed page is never a shared cache proof. */
export function admitPublicationStream(
  response: Response,
  context: RequestContext,
  headers: readonly string[],
  required: PublicationRequirement | undefined,
): Response {
  const state = (): { readonly valid: boolean; readonly ready: boolean } => {
    return livePublicationState(
      context.publication,
      [...headers, ...(context.resourceTags ?? [])],
      required,
      nowMs(),
    );
  };
  const initial = state();
  if (!initial.valid || (!initial.ready && context.publicationReadStarted !== true))
    return markPublicationPolicy(
      admitPublication(response, ['upwind:publication:invalid'], nowMs()),
    );
  if (response.body === null) {
    return initial.ready
      ? privateResponse(response, null)
      : markPublicationPolicy(admitPublication(response, ['upwind:publication:invalid'], nowMs()));
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        return context.run(async () => {
          try {
            if (!state().valid) throw new Error(UNAVAILABLE);
            const part = await reader.read();
            const current = state();
            if (!current.valid || (part.done && !current.ready)) throw new Error(UNAVAILABLE);
            if (part.done) controller.close();
            else controller.enqueue(part.value);
          } catch (error) {
            controller.error(error);
            try {
              await reader.cancel(error);
            } catch {
              // The failed response is already closed; cancellation cannot reopen it.
            }
          }
        });
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return privateResponse(response, body);
}
