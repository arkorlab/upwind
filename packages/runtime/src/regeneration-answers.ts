import {
  answerFromPublishing,
  answerFromRender,
  renderForVisitor,
  type Want,
  withOutcome,
} from './answers.ts';
import { requestContext } from './cache/context.ts';
import type { CurrentGeneration } from './cache/current.ts';
import type { RegenerationOutcome } from './cache/regenerate.ts';
import { servable } from './cache/servable.ts';
import type { PartialFallbackJob as Job } from './partial-fallback.ts';

/**
 * What a regeneration a request made, or met under way, comes to for the request's own answer: the
 * render, the one this isolate is publishing, the visitor's own, or a later generation the host
 * holds (`generations.ts`).
 */

/** The publish of the render this isolate makes or is making of the entry, where there is one. */
export function publishOf(outcome: RegenerationOutcome): Promise<unknown> | undefined {
  return outcome.kind === 'accepted' || outcome.kind === 'busy' ? outcome.published : undefined;
}

/**
 * Hold the answer's end for the publish of an entry's first generation, as for the request's other
 * writes (`RequestWrites`): a request made once it was read whole reads the generation published,
 * rather than finding none and rendering a page of its own. An expired entry's regeneration holds
 * no answer so: the generation before it is there to be judged, and a publish behind a broad
 * invalidation waits for that invalidation's records to be rewritten first — a page held open for
 * it is one the browser has not finished loading, prefetching about it, for as long as the hold.
 */
export function holdFirstPublish(outcome: RegenerationOutcome): void {
  // A request answered from a render this isolate is publishing of the entry waits for that
  // publish as the request the render was made for does: its answer is the first generation's too.
  const published = publishOf(outcome);
  if (published !== undefined) {
    requestContext()?.writes.add(published);
  }
}

/**
 * The visitor's answer from a regeneration just made: the render, as soon as it is made, its
 * publish still under way behind the answer — which the outcome says (`accepted`) rather than claim
 * a commit the bytes went out ahead of; their own render when the entry could not be published
 * now; nothing when the entry is dynamic here, which leaves the request to the usual path.
 *
 * A render published as something a visitor may not be answered with — a redirect that does not
 * say where it leads — is one the visitor never saw, so the outcome the response carries says so
 * rather than `accepted`, which whatever reads it would take for the bytes that went out.
 */
export async function answerFromJob(
  job: Job,
  outcome: RegenerationOutcome,
  want: Want,
): Promise<Response | undefined> {
  if (outcome.kind === 'accepted' && servable(outcome.render.status, outcome.render.headers)) {
    const answered = await answerFromRender(job.input, job.target.handler, outcome.render, want);
    return answered === undefined ? undefined : withOutcome(answered, 'accepted');
  }
  if (outcome.kind === 'skipped') {
    return undefined;
  }
  // The render this isolate is publishing of the entry, or has just published: the page the requests
  // after its publish are answered with, already made.
  const publishing =
    outcome.kind === 'busy' || outcome.kind === 'superseded' ? outcome.publishing : undefined;
  const ours = await answerFromPublishing(job.input, job.target.handler, publishing, want);
  if (ours !== undefined) {
    return ours;
  }
  // A later generation the host holds, whose record its answer carried and this isolate now holds
  // (`RegenerationOutcome.current`): the usual path answers with it, as with any record read.
  if (laterOf(outcome) !== undefined) {
    return undefined;
  }
  // `busy`, and `superseded` — a later generation than the one judged is the host's, which this
  // isolate's read is behind — are answered alike otherwise: with a render of the visitor's own,
  // kept by no one.
  const own = await renderForVisitor(job.input, job.target, want);
  const said = outcome.kind === 'accepted' ? 'unservable' : outcome.kind;
  return own === undefined ? undefined : withOutcome(own, said);
}

/**
 * The later generation the host holds that a regeneration came back with, from the record the
 * host's answer for the lease carried (`RegenerationOutcome.current`).
 */
export function laterOf(outcome: RegenerationOutcome): CurrentGeneration | undefined {
  return outcome.kind === 'busy' || outcome.kind === 'superseded' ? outcome.current : undefined;
}
