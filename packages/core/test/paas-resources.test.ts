import { describe, expect, it } from 'vitest';

import {
  formatResourcesManifest,
  parseResourcesManifest,
  RESOURCE_TYPES,
} from '../src/paas/resources.ts';

/**
 * `ARKOR_RESOURCES`, the list of a deployment's storage bindings a host writes and the runtime
 * reads: one format, and a reader that publishes nothing it does not understand.
 */

describe('the resources manifest', () => {
  it('reads back what was written, and nothing but names and kinds', () => {
    const entries = RESOURCE_TYPES.map((type, index) => ({ name: `B${index}`, type }));
    const written = formatResourcesManifest(
      entries.map((entry) => ({ ...entry, resourceRef: 'never-written' })),
    );

    expect(written).not.toContain('never-written');
    expect(parseResourcesManifest(written)).toStrictEqual(entries);
  });

  it.each([
    ['nothing', undefined],
    ['text that is not JSON', 'CACHE'],
    ['an object', '{"name":"CACHE","type":"d1"}'],
  ])('reads %s as no bindings', (_, raw) => {
    expect(parseResourcesManifest(raw)).toStrictEqual([]);
  });

  it('leaves out an entry it cannot publish, and keeps the rest', () => {
    const raw = JSON.stringify([
      { name: 'QUEUE', type: 'queue' },
      { name: '', type: 'd1' },
      { name: 7, type: 'd1' },
      'DB',
      { name: 'DB', type: 'd1' },
    ]);

    expect(parseResourcesManifest(raw)).toStrictEqual([{ name: 'DB', type: 'd1' }]);
  });
});
