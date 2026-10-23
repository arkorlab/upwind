import type { RouteEntry } from '@stayingupwind/core/manifest';
import { documentTerminates } from '@stayingupwind/core/util';

import { answeredBy, EDGE_HEADER } from './answers.ts';
import type { Reading } from './reading.ts';

/**
 * Why a document is not complete: its continuation failed, or it never ended — as a deployment's
 * validation and the edge's splice tell a whole document (`documentTerminates`: `</body></html>`,
 * and no more than a little whitespace after them), which a tail as long as `reading.ts` keeps
 * decides.
 */
export function incompleteness(answer: Reading): string | undefined {
  if (answer.marked) {
    return 'its continuation failed, and the edge ended it with its recovery';
  }
  if (!documentTerminates(answer.tail)) {
    return 'the document does not end with </body></html>';
  }
  return undefined;
}

/**
 * Why a document a route's build finished is not as the edge serves one (validation's own rule):
 * the shell, whole — the edge says no continuation followed it (`cont=none`) — and nothing more.
 * A generation rendered since the build's is whole as its own state says (`isCompleteDocument` in
 * the edge), which the stack's edge read it with (`partial`): one holding the postponed state of a
 * later render is resumed, whatever the build finished (greptile).
 */
export function finishedFailure(
  route: RouteEntry,
  answer: Reading,
  served: {
    readonly rendered: boolean;
    readonly shell: Buffer;
    /** Whether the generation rendered since that it was served from holds a resume's state. */
    readonly partial?: boolean | undefined;
  },
): string | undefined {
  if (route.cache?.delivery !== 'complete') {
    return undefined;
  }
  const answered = answeredBy(answer);
  const whole = answered.split(';').includes('cont=none');
  if (served.rendered && served.partial !== undefined) {
    if (served.partial !== whole) {
      return undefined;
    }
    return served.partial
      ? `answered whole, though the generation it was served from holds a resume's state (${EDGE_HEADER}: ${answered})`
      : `continued, though the build finished it and the generation it was served from is complete (${EDGE_HEADER}: ${answered})`;
  }
  if (!whole) {
    return `continued, though the build finished it (${EDGE_HEADER}: ${answered})`;
  }
  // Its length is the build's only for the build's own generation: its shell, as the edge serves it.
  const finished = served.shell.byteLength;
  return served.rendered || answer.length === finished
    ? undefined
    : `answered ${answer.length} bytes, not the ${finished} the build finished`;
}
