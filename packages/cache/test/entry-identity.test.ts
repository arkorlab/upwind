import { deriveEntry, type EntryDescriptor } from '@stayingupwind/core/cache';
import { MAX_DATA_KEY_LENGTH } from '@stayingupwind/host/cache';
import { describe, expect, it } from 'vitest';

import { requestedEntryId } from '../src/function/entry-identity.ts';

const DESCRIPTORS: readonly EntryDescriptor[] = [
  { kind: 'app-page', route: '/articles/[slug]', pathname: '/articles/a/' },
  { kind: 'pages', route: '/articles/[slug]', pathname: '/articles/a' },
  { kind: 'app-route', route: '/api/[name]', pathname: '/api/日本語' },
  { kind: 'app-page', route: '/日本語', pathname: '/日本語\u{D800}/' },
  { kind: 'data:fetch', key: 'same-key' },
  { kind: 'data:use-cache', handler: 'default', key: 'same-key' },
  { kind: 'data:use-cache', handler: '日本語\u{D800}', key: 'quotes"\\\n\u{D800}' },
  { kind: 'data:fetch', key: 'x'.repeat(MAX_DATA_KEY_LENGTH) },
];

describe('the synchronous identity of a requested entry', () => {
  describe.each([
    { name: 'ascii', scope: 'scope_ascii' },
    { name: 'Unicode', scope: 'scope_日本語' },
    { name: 'lone surrogate', scope: 'scope_\u{D800}' },
  ])('$name scope', ({ scope }) => {
    it.each(DESCRIPTORS)('equals core for $kind', async (descriptor) => {
      const expected = await deriveEntry(scope, descriptor, ['language']);

      const identity = requestedEntryId(scope, descriptor);

      expect(identity).toBe(expected.entryId);
      expect(identity).toBeTypeOf('string');
    });
  });

  it('keeps namespace, scope, route, key and handler separation', () => {
    const names = [
      ...DESCRIPTORS.map((descriptor) => requestedEntryId('scope_one', descriptor)),
      ...DESCRIPTORS.map((descriptor) => requestedEntryId('scope_two', descriptor)),
    ];

    expect(new Set(names).size).toBe(names.length);
  });
});
