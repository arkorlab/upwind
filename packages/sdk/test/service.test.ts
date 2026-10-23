import { afterEach, describe, expect, it } from 'vitest';

import { service as fromIndex } from '../src/index.ts';
import { published } from '../src/published.ts';
import { service } from '../src/service.ts';

const KEY = Symbol.for('upwind.resources');
const BEFORE = Object.getOwnPropertyDescriptor(globalThis, KEY);

function publish(resources: Record<string, unknown>, version = 1): void {
  Object.defineProperty(globalThis, KEY, {
    configurable: true,
    value: { version, resources },
  });
}

describe('service', () => {
  afterEach(() => {
    if (BEFORE === undefined) Reflect.deleteProperty(globalThis, KEY);
    else Object.defineProperty(globalThis, KEY, BEFORE);
  });

  it('returns the native binding without making a call or wrapping its response stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    });
    const answer = new Response(body);
    class Api {
      calls = 0;

      fetch() {
        this.calls += 1;
        return Promise.resolve(answer);
      }
    }
    const api = new Api();
    publish({ API: { type: 'service', binding: api } });

    const binding = fromIndex('API');

    expect(binding).toBe(api);
    expect(published()?.resources['API']?.binding).toBe(api);
    expect(api.calls).toBe(0);
    expect(binding).toBeDefined();

    const response = await binding?.fetch('https://api.internal/hello');

    expect(response).toBe(answer);
    expect(response?.body).toBe(body);
    await expect(response?.text()).resolves.toBe('hello');
    expect(api.calls).toBe(1);
  });

  it('does not substitute another binding or an inherited name', () => {
    const api = { fetch: () => Promise.resolve(new Response('hello')) };
    const resources = Object.assign(
      Object.create({ INHERITED: { type: 'service', binding: api } }) as Record<string, unknown>,
      {
        API: { type: 'service', binding: api },
        DB: { type: 'd1', binding: api },
      },
    );
    publish(resources);

    expect(service('MISSING')).toBeUndefined();
    expect(service('DB')).toBeUndefined();
    expect(service('INHERITED')).toBeUndefined();
  });

  it('returns nothing when no capabilities are published', () => {
    Reflect.deleteProperty(globalThis, KEY);

    expect(service('API')).toBeUndefined();
  });

  it('reports an unreadable publication rather than disguising it as a missing service', () => {
    publish({ API: { type: 'service', binding: {} } }, 2);

    expect(() => service('API')).toThrow('reads version 1');
  });
});
