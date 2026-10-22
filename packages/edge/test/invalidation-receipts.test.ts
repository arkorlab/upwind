import { describe, expect, it } from 'vitest';

import { takeInvalidation } from '../src/cache/condemned.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { InvalidationMemory } from '../src/memory/invalidations.ts';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('response invalidation revisions', () => {
  it('retains the first observation of a revision through duplicate, older and legacy responses', () => {
    let now = T0;
    const memory = new InvalidationMemory(() => now);
    memory.takeResponse('scope', ['products'], 9);

    now += MINUTE;
    memory.takeResponse('scope', ['products'], 9);
    memory.takeResponse('scope', ['other'], 7);
    memory.takeResponse('scope', ['legacy'], undefined);

    expect(memory.responseRevisionOf('scope')).toStrictEqual({ revision: 9, observedAt: T0 });

    memory.takeResponse('scope', ['products'], 10);

    expect(memory.responseRevisionOf('scope')).toStrictEqual({
      revision: 10,
      observedAt: now,
    });
  });

  it('does not create or renew a response revision from authority samples', () => {
    let now = T0;
    const memory = new InvalidationMemory(() => now);
    memory.takeEach('scope', { atOnce: [{ tag: 'products', revision: 7 }], windowed: [] });
    memory.take('scope', undefined, 7);

    expect(memory.responseRevisionOf('scope')).toBeUndefined();

    memory.takeResponse('scope', ['products'], 8);
    now += MINUTE;
    memory.takeEach('scope', { atOnce: [{ tag: 'products', revision: 9 }], windowed: [] });
    memory.take('scope', undefined, 10);

    expect(memory.responseRevisionOf('scope')).toStrictEqual({ revision: 8, observedAt: T0 });
  });

  it('stops forwarding an old response revision without dropping its condemnation bounds', () => {
    let now = T0;
    const memory = new InvalidationMemory(() => now);
    memory.takeResponse('scope', ['products'], 7);
    now += 10 * MINUTE;

    expect(memory.responseRevisionOf('scope')).toStrictEqual({ revision: 7, observedAt: T0 });

    now += 1;
    memory.takeResponse('scope', ['products'], 7);
    memory.takeResponse('scope', ['legacy'], undefined);
    memory.takeEach('scope', { atOnce: [], windowed: [] });

    expect(memory.responseRevisionOf('scope')).toBeUndefined();
    expect(memory.of('scope')?.tags.get('products')).toBe(7);
  });

  it('expires the response and bounds together, without reads renewing them', () => {
    let now = T0;
    const memory = new InvalidationMemory(() => now);
    memory.takeResponse('scope', ['products'], 7);
    now += MINUTE;

    expect(memory.responseRevisionOf('scope')?.revision).toBe(7);

    now = T0 + HOUR;

    expect(memory.responseRevisionOf('scope')).toBeUndefined();
    expect(memory.of('scope')).toBeUndefined();
    expect(memory.usedBytes).toBe(0);
  });

  it('preserves a response through folding and charges it within the existing memory budget', () => {
    let now = T0;
    const memory = new InvalidationMemory(() => now);
    memory.takeResponse('scope', ['products'], 7);
    now += MINUTE;
    memory.takeEach('scope', {
      atOnce: Array.from({ length: 65 }, (_, index) => ({ tag: `product-${index}`, revision: 9 })),
      windowed: [],
    });
    const withoutResponse = new InvalidationMemory(() => T0);
    withoutResponse.take('scope', undefined, 9);

    expect(memory.of('scope')?.every).toBe(9);
    expect(memory.responseRevisionOf('scope')).toStrictEqual({ revision: 7, observedAt: T0 });
    expect(memory.usedBytes).toBeGreaterThan(withoutResponse.usedBytes);

    const bounded = new InvalidationMemory(() => T0, 256);
    for (const scope of ['first', 'second', 'third']) {
      bounded.takeResponse(scope, undefined, 7);
    }

    expect(bounded.usedBytes).toBeLessThanOrEqual(256);
    expect(bounded.responseRevisionOf('first')).toBeUndefined();
    expect(bounded.of('first')).toBeUndefined();
    expect(bounded.responseRevisionOf('third')?.revision).toBe(7);
  });

  it.each([
    { destination: 9, source: 7, expected: 9, observedAt: T0 },
    { destination: 7, source: 9, expected: 9, observedAt: T0 + MINUTE },
    { destination: 9, source: 9, expected: 9, observedAt: T0 },
  ])('moves revision $source into $destination with its own observation time', (example) => {
    let now = T0;
    const memory = new InvalidationMemory(() => now);
    memory.takeResponse('actual', ['products'], example.destination);
    now += MINUTE;
    memory.takeResponse('deployment', ['products'], example.source);

    expect(memory.move('deployment', 'actual')).toBe('bounded');
    expect(memory.responseRevisionOf('deployment')).toBeUndefined();
    expect(memory.responseRevisionOf('actual')).toStrictEqual({
      revision: example.expected,
      observedAt: example.observedAt,
    });
    expect(memory.responseRevisionOf('other-deployment')).toBeUndefined();
  });

  it('does not renew an expired response when its provisional scope is transferred', () => {
    let now = T0;
    const memory = new InvalidationMemory(() => now);
    memory.takeResponse('deployment', ['products'], 7);
    now += 10 * MINUTE + 1;

    memory.move('deployment', 'actual');

    expect(memory.responseRevisionOf('actual')).toBeUndefined();
    expect(memory.of('actual')?.tags.get('products')).toBe(7);
  });

  it.each([null, '-1', '1.5', '1e3', ' 7', '9007199254740992', '0'])(
    'creates no response hint from an absent or invalid bound %s',
    (bound) => {
      const memory = createEdgeMemory(() => T0);

      takeInvalidation(memory, 'scope', { value: 'products', bound });

      expect(memory.invalidations.responseRevisionOf('scope')).toBeUndefined();
    },
  );
});
