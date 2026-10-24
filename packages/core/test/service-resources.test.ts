import { describe, expect, it } from 'vitest';

import {
  formatResourcesManifest,
  parseResourcesManifest,
  publishedD1BindingCount,
  RESOURCE_TYPES,
  RESOURCES_MANIFEST_BINDING,
  resourcesOf,
} from '../src/paas/resources.ts';

describe('published service capabilities', () => {
  it('round-trips services without including them among provisionable resources', () => {
    const entries = [{ name: 'API', type: 'service' }] as const;

    expect(parseResourcesManifest(formatResourcesManifest(entries))).toStrictEqual(entries);
    expect(RESOURCE_TYPES).not.toContain('service');
  });

  it('publishes only listed own bindings and leaves the native capability untouched', () => {
    const api = { fetch: () => new Response('hello') };
    const inherited = { INHERITED: api };
    const env = Object.assign(Object.create(inherited) as Record<string, unknown>, {
      [RESOURCES_MANIFEST_BINDING]: formatResourcesManifest([
        { name: 'API', type: 'service' },
        { name: 'INHERITED', type: 'service' },
        { name: 'URL', type: 'service' },
      ]),
      API: api,
      UNLISTED: api,
      URL: 'https://api.example',
    });
    const published = resourcesOf(env);

    expect(Object.keys(published.resources)).toStrictEqual(['API']);
    expect(published.resources['API']?.binding).toBe(api);
    expect(Object.isFrozen(published.resources['API'])).toBe(true);
    expect(Object.isFrozen(api)).toBe(false);
    expect(publishedD1BindingCount(env)).toBe(0);
  });
});
