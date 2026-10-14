import { r2ArtifactKey } from '@stayingupwind/core/artifact';
import { releaseStream } from '@stayingupwind/core/util';
import type { ShellDeliveryStrategy } from '@stayingupwind/host/delivery';

import type { EdgeContext } from './context.ts';
import { ShellSizeMismatchError } from './shell-loader.ts';

export const r2ShellStrategy: ShellDeliveryStrategy<EdgeContext, 'r2'> = {
  id: 'r2',
  async getShell(ref, ctx) {
    const startedAt = ctx.runtime.now();
    const object = await ctx.env.ARTIFACTS.get(r2ArtifactKey(ref.sha256));
    if (object === null) {
      return;
    }
    // An object of another size than the manifest's is not the shell, whatever it holds: refused on
    // the size it states, before its body is read into memory.
    if (object.size !== ref.byteLength) {
      releaseStream(object.body, 'a shell object of another size');
      throw new ShellSizeMismatchError(object.size);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    return { bytes, source: 'r2', latencyMs: ctx.runtime.now() - startedAt };
  },
};
