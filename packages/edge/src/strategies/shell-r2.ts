import { r2ArtifactKey } from '@stayingupwind/core/artifact';
import type { ShellDeliveryStrategy } from '@stayingupwind/host/delivery';

import type { EdgeContext } from './context.ts';

export const r2ShellStrategy: ShellDeliveryStrategy<EdgeContext> = {
  id: 'r2',
  async getShell(ref, ctx) {
    const startedAt = ctx.runtime.now();
    const object = await ctx.env.ARTIFACTS.get(r2ArtifactKey(ref.sha256));
    if (object === null) {
      return;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    return { bytes, source: 'r2', latencyMs: ctx.runtime.now() - startedAt };
  },
};
