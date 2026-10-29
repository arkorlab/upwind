// eslint-disable-next-line n/no-unsupported-features/node-builtins -- synchronous same-realm hooks have been available since Node 22.15; this CLI requires Node 24
import { registerHooks } from 'node:module';

import { isWebSocketResponseBridgeSource, webSocketResponseBridge } from '@stayingupwind/core/next';

import { installNextResourceCacheLoader } from '../resources/next-cache-loader.ts';
import { isNextRuntimeModule } from '../resources/next-module.ts';
import { getOrStartLocalResources } from '../resources/shared.ts';
import { createDevWebSocketBridge, RAW_UPGRADE } from './websocket-bridge.ts';
import { installWebSocketGlobals } from './websocket-globals.ts';

export const NEXT_WEBSOCKET_DEV = 'upwind.next-websocket-dev@1';
const KEY = Symbol.for(NEXT_WEBSOCKET_DEV);
const GLOBAL = `globalThis[Symbol.for(${JSON.stringify(NEXT_WEBSOCKET_DEV)})]`;

interface DevState {
  readonly closeConnections: () => Promise<void>;
}

export async function closeWebSocketDev(): Promise<void> {
  const globals = globalThis as typeof globalThis & { [KEY]?: DevState };
  await globals[KEY]?.closeConnections();
}

function replaceOnce(
  source: string,
  pattern: RegExp,
  replacement: (matched: string) => string,
  name: string,
): string {
  if ([...source.matchAll(pattern)].length !== 1) {
    throw new Error(`upwind: this Next.js ${name} has an unsupported WebSocket contract`);
  }
  return source.replaceAll(pattern, (match) => replacement(match));
}

/** Keep Next's own origin/HMR handling; only its unsupported application-upgrade branch changes. */
export function bridgeRouterServer(source: string): string {
  const startup = replaceOnce(
    source,
    /async function initialize\(opts\)\s*\{/gu,
    (match) => `${match}\nif (opts.dev) await ${GLOBAL}.prepare(opts);`,
    'router initializer',
  );
  return replaceOnce(
    startup,
    /const res = new [\w$.]+\.MockedResponse\(\{\s*resWriter:/gu,
    (match) => `return ${GLOBAL}.upgrade(req, socket, head, requestHandler);\n${match}`,
    'application upgrade handler',
  );
}

/** Register Next's sole Upgrade listener before the first HTTP request, including a cold WS first. */
export function eagerNextUpgradeListener(source: string): string {
  return replaceOnce(
    source,
    /getRequestHandler\(\)\s*\{\s*return async[^{}]+\{\s*this\.setupWebSocketHandler\(this\.options\.httpServer, req\);/gu,
    (match) => match.replace('{', '{ this.setupWebSocketHandler(this.options.httpServer);'),
    'custom server listener',
  );
}

/** External rewrites retain Next's existing WebSocket proxy, with the original bytes after headers. */
export function bridgeProxyRequest(source: string): string {
  return replaceOnce(
    source,
    /async function proxyRequest\(req, res, parsedUrl, upgradeHead, reqBody, proxyTimeout\)\s*\{/gu,
    (match) =>
      `${match}\nconst upwindUpgrade = res[Symbol.for(${JSON.stringify(RAW_UPGRADE)})];\nif (upwindUpgrade) { res.finished = true; upgradeHead = upwindUpgrade.head; res = upwindUpgrade.socket; }`,
    'external rewrite proxy',
  );
}

interface NextStartup {
  readonly dev?: boolean;
  readonly dir: string;
  readonly onDevServerCleanup?: (cleanup: () => Promise<void>) => void;
}

/** Installed only by development entrypoints, before the project's Next.js is imported. */
export function installWebSocketDev(): void {
  const globals = globalThis as typeof globalThis & { [KEY]?: unknown };
  if (globals[KEY] !== undefined) return;
  installWebSocketGlobals();
  installNextResourceCacheLoader();
  const bridge = createDevWebSocketBridge();
  let cleanup: (() => Promise<void>) | undefined;
  globals[KEY] = {
    upgrade: bridge.upgrade,
    closeConnections: bridge.close,
    prepare: async (options: NextStartup) => {
      const resources = await getOrStartLocalResources(options.dir, {
        mode: 'development',
        answersSignals: false,
      });
      cleanup ??= async () => {
        await bridge.close();
        await resources.dispose();
      };
      options.onDevServerCleanup?.(cleanup);
    },
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!isNextRuntimeModule(url) || result.source === undefined) return result;
      let source =
        typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      if (url.endsWith('/next/dist/server/lib/router-server.js'))
        source = bridgeRouterServer(source);
      else if (url.endsWith('/next/dist/server/next.js')) source = eagerNextUpgradeListener(source);
      else if (url.endsWith('/next/dist/server/lib/router-utils/proxy-request.js'))
        source = bridgeProxyRequest(source);
      if (isWebSocketResponseBridgeSource(source))
        source = webSocketResponseBridge(source).contents;
      return source === result.source ? result : { ...result, source };
    },
  });
}
