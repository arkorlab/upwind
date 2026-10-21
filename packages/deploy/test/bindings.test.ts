import { PREFETCH_SERVICE_BINDING } from '@stayingupwind/host/bindings';
import { PREFETCH_DEPLOYMENT_ENTRYPOINT } from '@stayingupwind/host/prefetch-audit';
import { describe, expect, it } from 'vitest';

import { functionBindings } from '../src/bindings.ts';
import type { PrefetchBlobs } from '../src/prefetch.ts';

const CAPABILITIES: readonly PrefetchBlobs[] = [{}, { ['a'.repeat(64)]: true }];

function conditionalService(prefetch: string | undefined) {
  return functionBindings({ deploymentId: 'deployment', prefetch, prefetchBlobs: {} });
}

describe('a Function prefetch service requires an explicit deployment capability', () => {
  it('keeps hosts without a prefetch service admissible', () => {
    const bindings = functionBindings({ deploymentId: 'deployment' });

    expect(bindings.services).toStrictEqual([]);
  });

  it.each(CAPABILITIES)('binds exactly the explicitly supplied capabilities: %j', (allowed) => {
    const bindings = functionBindings({
      deploymentId: 'deployment',
      prefetch: 'prefetch-worker',
      prefetchBlobs: allowed,
    });

    expect(bindings.services).toStrictEqual([
      {
        name: PREFETCH_SERVICE_BINDING,
        service: 'prefetch-worker',
        entrypoint: PREFETCH_DEPLOYMENT_ENTRYPOINT,
        props: { allowedSha256: allowed },
      },
    ]);
  });

  it('rejects the old missing-capability call both statically and at deployment time', () => {
    const legacy = { deploymentId: 'deployment', prefetch: 'prefetch-worker' };

    expect(() =>
      // @ts-expect-error A prefetch service now requires its explicit deployment capability.
      functionBindings(legacy),
    ).toThrow('prefetchBlobs is required with prefetch');
  });

  it('allows a host to supply the capability before deciding whether to bind the service', () => {
    const absent = conditionalService(undefined);
    const present = conditionalService('prefetch-worker');

    expect(absent.services).toStrictEqual([]);
    expect(present.services).toHaveLength(1);
  });
});
