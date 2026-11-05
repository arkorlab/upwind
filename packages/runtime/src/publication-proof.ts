import type { PublicationRequirement } from '@stayingupwind/core/cache';

/** Trusted build proof follows response copies without importing request or cache machinery. */
const independentResponses = new WeakMap<Response, PublicationRequirement>();

export function markBuildPublication(response: Response, proof: PublicationRequirement): void {
  independentResponses.set(response, proof);
}

export function buildPublicationOf(response: Response): PublicationRequirement | undefined {
  return independentResponses.get(response);
}

export function copyBuildPublication(source: Response, target: Response): Response {
  const proof = independentResponses.get(source);
  if (proof !== undefined) independentResponses.set(target, proof);
  return target;
}
