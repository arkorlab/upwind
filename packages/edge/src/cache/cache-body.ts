import { releaseStream } from '@stayingupwind/core/util';

import { cuttable, type Cuttable } from '../handlers/image-stream.ts';

/** A cache body's read, which its deadline or the source that beats it can give up. */
export class CacheBody {
  #body: Cuttable | undefined;
  #stopped = false;

  get stopped(): boolean {
    return this.#stopped;
  }

  stop(): void {
    this.#stopped = true;
    this.#body?.cut(new Error('cache body no longer needed'));
    this.#body = undefined;
  }

  open(hit: Response): Response | undefined {
    if (this.#stopped) {
      releaseStream(hit.body, 'cache body no longer needed');
      return undefined;
    }
    if (hit.body === null) return hit;
    this.#body = cuttable(hit.body as ReadableStream<Uint8Array>);
    return new Response(this.#body.stream);
  }
}
