import { isPagesDataRequestPath } from '@stayingupwind/core/bundle';
import { NEXT_DATA_HEADER } from '@stayingupwind/core/request';

import { stripPlatformHeaders } from './incoming.ts';

/**
 * The client's headers as the middleware and the handler after it are given them: without the
 * platform's own, and with `x-nextjs-data` decided by the path rather than taken from the client.
 *
 * Next.js drops that header from what a client sends (`filterInternalHeaders`) and puts it back
 * itself when the path is a data request (`server/lib/router-utils/resolve-routes.ts`). The edge
 * drops it before a request reaches this Function, and `@next/routing` puts nothing back. It is how a
 * middleware knows it is answering a client navigation's `_next/data` fetch, which it answers with
 * `x-nextjs-redirect` or `x-nextjs-rewrite` for the client's router to follow. Without it a
 * redirect comes back as a `Location` the fetch cannot use and a rewrite comes back unnamed, and
 * the router gives up and loads the whole page.
 */
export function routedHeaders(request: Request, url: URL, basePath: string): Headers {
  const headers = stripPlatformHeaders(request.headers);
  headers.delete(NEXT_DATA_HEADER);
  if (isPagesDataRequestPath(basePath, url.pathname)) {
    headers.set(NEXT_DATA_HEADER, '1');
  }
  return headers;
}
