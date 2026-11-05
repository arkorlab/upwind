import type { NodeHandler } from './app-module.ts';
import type { GenerationSource } from './generation-source.ts';
import { serveFromGeneration } from './generations.ts';
import type { RoutedInput } from './serve.ts';
import type { Store } from './store.ts';

/**
 * The answer from the entry's generation (`serveFromGeneration`), or else the caller's own
 * (`otherwise`), told whether the entry's record did not come in time where the entry is rendered
 * at a miss (`onRenderLeft`): a render the caller then makes for the request is one at a miss
 * (`answeredAtMiss`).
 */
export async function servedOrOtherwise(
  input: RoutedInput,
  store: Store,
  asked: { readonly source: GenerationSource; readonly handler: NodeHandler },
  otherwise: (renderLeft: boolean) => Promise<Response>,
): Promise<Response> {
  const told = { renderLeft: false };
  const source = {
    ...asked.source,
    onRenderLeft: () => {
      told.renderLeft = true;
    },
  };
  return (
    (await serveFromGeneration(input, store, source, asked.handler)) ?? otherwise(told.renderLeft)
  );
}
