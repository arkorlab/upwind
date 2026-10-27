import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  CAPTURE_HEADER,
  pathHeaders,
} from '@stayingupwind/core/paas';

import type { GateCapture } from './gate.ts';

/** What asks the Function for a capture (`CAPTURE_HEADER`). */
const CAPTURE_ASKED = '1';

/**
 * What the route's Function is told of a capture its gate asked for: that it is one
 * (`CAPTURE_HEADER`), and the route whose page it renders the request's pathname as, named up front
 * as a resume or a regeneration names one (`CACHE_ROUTE_HEADER`). Both go with the request wherever
 * it is sent on — to the Worker a split deployment's first one names as the route's own
 * (`dispatchSplit`) — and whatever answers, the render or why there is none to hand over, is the
 * answer.
 */
export function capturedHeaders(capture: GateCapture): Readonly<Record<string, string>> {
  return {
    [CAPTURE_HEADER]: CAPTURE_ASKED,
    ...pathHeaders(CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER, capture.route),
  };
}
