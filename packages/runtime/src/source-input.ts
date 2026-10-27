import type { RoutedInput } from './serve.ts';

/**
 * The request for an image's source, as a request of its own: routed afresh, its middleware run for
 * its own path or not at all. Nothing of what the image request's routing came to carries over — the
 * edge asks for a source as an anonymous request of its own (`fetchImageSource`) — so a source the
 * middleware never ran for is not answered as one it gated, nor under a status it never named.
 */
export function sourceInput(input: RoutedInput, source: Request): RoutedInput {
  return {
    ...input,
    request: source,
    initURL: source.url,
    middlewareRan: undefined,
    middlewareHeaders: undefined,
    askedHeaders: undefined,
    rewriteStatus: undefined,
    routingHeaders: undefined,
  };
}
