import { describe, expect, it, vi } from 'vitest';

import {
  isLogCorrelationId,
  LOG_CONTEXT_MESSAGE,
  logContextEnvelope,
  MAX_LOG_CONTEXT_BYTES,
  readLogContext,
} from '../src/paas/index.ts';

function marker(context: unknown) {
  return { message: LOG_CONTEXT_MESSAGE, __upwindLogContext: 1, context };
}

describe('runtime log context protocol', () => {
  it('copies only own enumerable data entries and preserves prototype-like names', () => {
    const context = Object.assign(Object.create(null) as Record<string, string>, {
      userId: 'usr_42',
      tenantId: 'tenant_7',
      constructor: 'constructor-id',
    });
    Object.defineProperty(context, '__proto__', { enumerable: true, value: 'prototype-id' });
    Object.defineProperty(context, 'hidden', { value: 'ignored' });
    const envelope = logContextEnvelope(context);
    context['userId'] = 'changed';

    expect(envelope?.message).toBe(LOG_CONTEXT_MESSAGE);
    expect(envelope?.__upwindLogContext).toBe(1);
    expect(Object.entries(envelope?.context ?? {})).toStrictEqual([
      ['userId', 'usr_42'],
      ['tenantId', 'tenant_7'],
      ['constructor', 'constructor-id'],
      ['__proto__', 'prototype-id'],
    ]);
    expect(Object.getPrototypeOf(envelope?.context)).toBeNull();
    const serialized = JSON.stringify(envelope);
    const transmitted: unknown = JSON.parse(serialized);
    expect(readLogContext(transmitted)).toStrictEqual(envelope?.context);
  });

  it('accepts the entry, key and value limits without trimming or coercing IDs', () => {
    const context = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [String(index), 'value'] as const),
    );
    expect(logContextEnvelope(context)).toBeDefined();
    expect(logContextEnvelope({ ['k'.repeat(64)]: 'v'.repeat(200) })).toBeDefined();
    const identifiers = readLogContext(marker({ ' user ': ' value ', empty: '' }));
    expect(Object.entries(identifiers ?? {})).toStrictEqual([
      [' user ', ' value '],
      ['empty', ''],
    ]);
    const empty = readLogContext(marker({}));
    expect(empty).toBeDefined();
    expect(Object.entries(empty ?? {})).toStrictEqual([]);
  });

  it.each([
    null,
    undefined,
    'user-id',
    [],
    new Date(0),
    { '': 'empty-key' },
    { ['k'.repeat(65)]: 'value' },
    { userId: 'v'.repeat(201) },
    { userId: 42 },
    { userId: undefined },
    { userId: { nested: 'value' } },
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), 'value'] as const)),
    Object.create({ userId: 'inherited' }),
  ])('rejects invalid identifier maps without emitting partial context: %j', (context: unknown) => {
    expect(logContextEnvelope(context)).toBeUndefined();
    expect(readLogContext(marker(context))).toBeUndefined();
  });

  it('does not invoke getters or toJSON and contains throwing proxy traps', () => {
    const getter = vi.fn(() => 'usr_42');
    const toJSON = vi.fn(() => ({ userId: 'usr_42' }));
    const accessor = Object.defineProperty({}, 'userId', { enumerable: true, get: getter });
    const unreadable = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('cannot enumerate');
        },
      },
    );
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    for (const context of [accessor, { toJSON }, unreadable, proxy]) {
      expect(logContextEnvelope(context)).toBeUndefined();
      expect(readLogContext(marker(context))).toBeUndefined();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('counts the complete envelope in UTF-8, including escaped and multibyte values', () => {
    const context = Object.fromEntries(
      Array.from(
        { length: 14 },
        (_, index) => [String(index).padEnd(64, 'k'), 'v'.repeat(200)] as const,
      ),
    );
    const finalKey = 'final'.padEnd(64, 'k');
    context[finalKey] = '';
    const encoder = new TextEncoder();
    const room = MAX_LOG_CONTEXT_BYTES - encoder.encode(JSON.stringify(marker(context))).byteLength;
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(200);
    context[finalKey] = 'v'.repeat(room);

    const serialized = JSON.stringify(marker(context));
    expect(encoder.encode(serialized).byteLength).toBe(MAX_LOG_CONTEXT_BYTES);
    const read = readLogContext(marker(context));
    expect(Object.entries(read ?? {})).toStrictEqual(Object.entries(context));
    context[finalKey] += 'v';
    expect(logContextEnvelope(context)).toBeUndefined();

    const unicode = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [String(index), '😀'.repeat(100)] as const),
    );
    const escaped = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [String(index), '\n'.repeat(200)] as const),
    );
    expect(logContextEnvelope(unicode)).toBeUndefined();
    expect(logContextEnvelope(escaped)).toBeUndefined();
  });

  it('requires own versioned marker fields without evaluating envelope getters', () => {
    const getter = vi.fn(() => LOG_CONTEXT_MESSAGE);
    const accessor = Object.defineProperty({ __upwindLogContext: 1, context: {} }, 'message', {
      get: getter,
    });
    const malformed = [
      undefined,
      LOG_CONTEXT_MESSAGE,
      { message: LOG_CONTEXT_MESSAGE, context: {} },
      { message: LOG_CONTEXT_MESSAGE, __upwindLogContext: 2, context: {} },
      { message: 'ordinary log', __upwindLogContext: 1, context: {} },
      Object.create(marker({ userId: 'inherited' })),
      accessor,
    ];
    for (const envelope of malformed) expect(readLogContext(envelope)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('log correlation IDs', () => {
  it('accepts canonical UUID v4 values and rejects other IDs', () => {
    expect(isLogCorrelationId('46bd0e48-cbd8-4b3c-8e34-02d1bc66f1c2')).toBe(true);
    for (const value of [
      undefined,
      null,
      '',
      '46BD0E48-CBD8-4B3C-8E34-02D1BC66F1C2',
      '46bd0e48-cbd8-1b3c-8e34-02d1bc66f1c2',
      '46bd0e48-cbd8-4b3c-7e34-02d1bc66f1c2',
      '46bd0e48-cbd8-4b3c-8e34-02d1bc66f1c2\n',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(isLogCorrelationId(value)).toBe(false);
    }
  });
});
