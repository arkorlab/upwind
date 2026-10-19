import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FunctionSpec } from '@stayingupwind/core/bundle';
import type { MiniflareOptions, MiniflareWorkerConfig } from 'miniflare';

type Modules = NonNullable<MiniflareWorkerConfig['manifest']>['modules'];

/**
 * A Function the build wrote, as Miniflare runs it: its modules read from the blobs under `out`,
 * under the names and the root it is uploaded with, at its own compatibility date and flags.
 */
export async function functionWorker(
  name: string,
  spec: FunctionSpec,
  out: string,
): Promise<NonNullable<MiniflareOptions['workers']>[number]> {
  const modules: Modules = {};
  for (const module of spec.modules) {
    const bytes = await readFile(path.join(out, 'blobs', module.blob.sha256));
    modules[module.name] = {
      type: module.type === 'commonjs' ? 'cjs' : module.type,
      contents:
        module.type === 'data' || module.type === 'wasm'
          ? new Uint8Array(bytes)
          : bytes.toString('utf8'),
    };
  }
  return {
    config: {
      name,
      compatibilityDate: spec.compatibilityDate,
      compatibilityFlags: spec.compatibilityFlags,
      manifest: { mainModule: spec.mainModule, modulesRoot: '/bundle', modules },
    },
  };
}
