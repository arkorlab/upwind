import { realpathSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const local = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock(import('../src/resources/local.ts'), () => ({ startLocalResources: local.start }));

import { getOrStartLocalResources } from '../src/resources/shared.ts';

describe('the shared local resource owner', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for('upwind.local-resource-owner'));
    local.start.mockReset();
  });

  it('shares canonical paths, an in-flight start, first-owner options and cleanup', async () => {
    const starting = Promise.withResolvers<{ dispose: () => Promise<void> }>();
    const dispose = vi.fn(() => Promise.resolve());
    local.start.mockReturnValue(starting.promise);
    const firstOptions = { answersSignals: true, mode: 'development' as const };
    const first = getOrStartLocalResources(process.cwd(), firstOptions);
    const second = getOrStartLocalResources(`${process.cwd()}/.`, { answersSignals: false });

    expect(first).toBe(second);

    await Promise.resolve();

    expect(local.start).toHaveBeenCalledExactlyOnceWith(realpathSync(process.cwd()), firstOptions);

    starting.resolve({ dispose });
    const owner = await first;
    const again = await second;
    await Promise.all([owner.dispose(), again.dispose()]);

    expect(dispose).toHaveBeenCalledExactlyOnceWith();
    await expect(getOrStartLocalResources('/', { answersSignals: false })).rejects.toThrow(
      'another project',
    );
  });
});
