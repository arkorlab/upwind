import { realpathSync } from 'node:fs';
import path from 'node:path';

import { type LocalOptions, type LocalResources, startLocalResources } from './local.ts';

const OWNER = Symbol.for('upwind.local-resource-owner');

interface Owner {
  readonly projectDir: string;
  readonly resources: Promise<LocalResources>;
}

/** The preload and CLI can arrive through different bundles in the same server process. */
export function getOrStartLocalResources(
  projectDir: string,
  options: LocalOptions,
): Promise<LocalResources> {
  const canonical = realpathSync(path.resolve(projectDir));
  const globals = globalThis as typeof globalThis & { [OWNER]?: Owner };
  const existing = globals[OWNER];
  if (existing !== undefined) {
    if (existing.projectDir !== canonical) {
      return Promise.reject(
        new Error('upwind: this process already owns another project’s local resources'),
      );
    }
    return existing.resources;
  }
  // Publish the in-flight owner before startup can yield. The first caller owns startup options,
  // cancellation and cleanup; a preload must not start another runtime over the same storage.
  // eslint-disable-next-line unicorn/prefer-promise-try, unicorn/prefer-await -- Defer startup's synchronous work until the in-flight owner has been published below.
  const resources = Promise.resolve().then(async () => {
    const local = await startLocalResources(canonical, options);
    let stopping: Promise<void> | undefined;
    return {
      ...local,
      dispose: () => {
        stopping ??= local.dispose();
        return stopping;
      },
    };
  });
  globals[OWNER] = { projectDir: canonical, resources };
  return resources;
}
