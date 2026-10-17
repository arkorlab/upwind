// As in the application Function: platform hooks, then WebAssembly, then the generated modules.
// Application cache globals are installed only for app Functions (`cache/install.ts`).
import './environment.ts';
import 'arkor:wasm';
import { MIDDLEWARE_ONLY_HEADER } from '@stayingupwind/core/paas';
import app from 'arkor:app';
import edge from 'arkor:edge';

import type { AppModule, EdgeModule } from './app-module.ts';
import { functionEntry } from './function-entry.ts';
import { handleRequestWith } from './handle-context.ts';
import { answerMiddlewareOnly } from './middleware.ts';
import { resourceWarmOf } from './resource-warm-props.ts';
import type { RoutedInput } from './serve.ts';

const HTTP_NOT_FOUND = 404;

async function routeMiddleware(input: RoutedInput): Promise<Response> {
  if (input.request.headers.get(MIDDLEWARE_ONLY_HEADER) === '1') {
    return answerMiddlewareOnly(input);
  }
  return new Response('middleware function', { status: HTTP_NOT_FOUND });
}

/** Standalone middleware has no cache host, bundle blobs, routing tables or page renderer. */
const entry = functionEntry({
  configure: () => null,
  async answer({ request, waitUntil, props, invalidated }) {
    if (resourceWarmOf(props) !== undefined) {
      return Response.json({ v: 1, kind: 'unsupported' });
    }
    return handleRequestWith(
      {
        app: app as AppModule,
        edge: edge as EdgeModule,
        request,
        waitUntil,
        invalidated,
      },
      routeMiddleware,
    );
  },
});

// eslint-disable-next-line import-x/no-default-export
export default entry;
