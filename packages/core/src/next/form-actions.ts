import { order, releaseOf } from './releases.ts';

/** The first release with vercel/next.js#100740. */
const FORM_ACTION_RELEASE = '16.5.0';
/** The first canary with it. */
const FORM_ACTION_CANARY = '16.5.0-canary.28';

/**
 * Whether a Next.js version renders a Server Action posted by a form — sent without JavaScript, so
 * with no `Next-Action` header — as a whole document that still reads its page's caches from the
 * postponed state the host hands it.
 *
 * vercel/next.js#100740, first in 16.5.0-canary.28: such a post is rendered whole, with the resume
 * data cache taken out of that state and the state itself dropped. Before it, a version handed the
 * state answered with what follows the shell only (vercel/next.js#99756), and handed none it renders
 * the whole document with every cached value computed afresh. So the state is handed to a version
 * known to have the change, and to no other: one that cannot be read, or one the change was not
 * known to be in, renders afresh, which is the answer that is complete.
 *
 * A canary of 16.5.0 is held to its number; any other prerelease is judged by the release it is
 * numbered as, as `securityFloorOf` judges one.
 */
export function rendersFormActionsWithResumeData(version: string): boolean {
  const asked = releaseOf(version);
  const release = releaseOf(FORM_ACTION_RELEASE);
  const canary = releaseOf(FORM_ACTION_CANARY);
  if (asked === undefined || release === undefined || canary?.canary === undefined) {
    return false;
  }
  if (asked.canary !== undefined && order(asked, canary) === 0) {
    return asked.canary >= canary.canary;
  }
  return order(asked, release) >= 0;
}
