import { describe, expect, it } from 'vitest';

import { isNextRuntimeModule } from '../src/resources/next-module.ts';

describe('development Next source targeting', () => {
  it.each([
    'file:///project/node_modules/next/dist/server/send-response.js',
    'file:///project/node_modules/next/dist/esm/server/route-modules/app-route/module.js',
    'file:///project/node_modules/next/dist/compiled/next-server/app-route.runtime.dev.js',
    'file:///project/.next/dev/server/chunks/ssr/next-cache.js',
    'file:///project/custom-output/server/chunks/next-cache.js',
    'file:///project/custom-output/server/app/api/socket/route.js',
  ])('admits Next source or emitted server code: %s', (url) => {
    expect(isNextRuntimeModule(url)).toBe(true);
  });

  it.each([
    'file:///project/node_modules/@stayingupwind/adapter/dist/static-files.js',
    'file:///project/node_modules/upwind/dist/websocket-dev.js',
    'file:///project/packages/adapter/dist/static-files.js',
    'file:///project/node_modules/@stayingupwind/sdk/dist/websocket.js',
    'node:module',
  ])('leaves bundles containing the transform implementation untouched: %s', (url) => {
    expect(isNextRuntimeModule(url)).toBe(false);
  });
});
