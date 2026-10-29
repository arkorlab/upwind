import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  bridgeProxyRequest,
  bridgeRouterServer,
  eagerNextUpgradeListener,
} from '../src/dev/websocket-loader.ts';

const require = createRequire(import.meta.url);
function nextSource(name: string): string {
  return readFileSync(require.resolve(`next/dist/server/${name}.js`), 'utf8');
}

describe('the development Next WebSocket loader', () => {
  it('enters the ordinary router only after Next has handled HMR and origin checks', () => {
    const source = bridgeRouterServer(nextSource('lib/router-server'));
    const bridge = source.indexOf('.upgrade(req, socket, head, requestHandler)');

    expect(bridge).toBeGreaterThan(source.indexOf('.onHMR('));
    expect(bridge).toBeGreaterThan(source.indexOf('blockCrossSiteDEV('));
    expect(bridge).toBeLessThan(source.indexOf('isUpgradeReq: true'));
    expect(source).toContain('if (opts.dev) await globalThis');
  });

  it('installs the custom server listener before the first HTTP request', () => {
    const source = eagerNextUpgradeListener(nextSource('next'));

    expect(source).toContain(
      'getRequestHandler() { this.setupWebSocketHandler(this.options.httpServer);',
    );
  });

  it('preserves the raw upgrade head when a middleware or config rewrite targets an external server', () => {
    const source = bridgeProxyRequest(nextSource('lib/router-utils/proxy-request'));

    expect(source).toContain('upgradeHead = upwindUpgrade.head; res = upwindUpgrade.socket;');
    expect(source).toContain('res.finished = true;');
  });

  it('rejects an unknown or ambiguous Next implementation', () => {
    for (const patch of [bridgeRouterServer, eagerNextUpgradeListener, bridgeProxyRequest]) {
      expect(() => patch('unknown next source')).toThrow('unsupported WebSocket contract');
    }
    const source = nextSource('lib/router-server');

    expect(() => bridgeRouterServer(source + source)).toThrow('unsupported WebSocket contract');
  });
});
