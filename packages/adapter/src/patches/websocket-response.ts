import { isWebSocketResponseBridgeSource, webSocketResponseBridge } from '@stayingupwind/core/next';

import type { Patch } from './types.ts';

export const webSocketResponsePatch: Patch = {
  name: 'websocket-response',
  target:
    // eslint-disable-next-line require-unicode-regexp -- a bundler filter
    /(?:\/next\/dist\/(?:compiled\/next-server\/[\w-]+\.runtime\.prod|(?:esm\/)?server\/(?:send-response|route-modules\/app-route\/module))|\/server\/(?:chunks|app|pages)\/.+)\.js$/,
  marker: isWebSocketResponseBridgeSource,
  reaches: ['module', 'esm-module', 'server-runtime', 'build-output'],
  apply: (source) => ({ ...webSocketResponseBridge(source), notes: [] }),
};
